// Based on obsidianmd/obsidian-sample-plugin, commit 07ceb81d1fb3384af611ebf665a1ec42a7e5926d (0BSD).
import { Modal, Notice, Platform, Plugin, PluginSettingTab, TFile, requestUrl, type App } from "obsidian";
import { z } from "zod";
import buildManifest from "../sync-manifest.json";
import { SyncEngine, type EngineStatus, type Review } from "./sync/engine";
import { SyncDB } from "./sync/store";
import { ObsidianVaultPort } from "./sync/vault-port";
import { Transport, boundedRequest, normalizeEndpoint } from "./sync/transport";
import { SyncOverview } from "./ui/sync-panels";
import { AutomaticSync, RemoteEvents, SerialWork } from "./sync/realtime";
import { desktopProtector } from "./desktop/protector";
import { RememberedUnlock } from "./desktop/remembered-unlock";
import { randomId } from "./sync/crypto";
import { connectionSettings } from "./sync/connection-settings";
import { connectionFailure, type ConnectionObserver, type ConnectionStep } from "./sync/connection-check";
import { connectionForm } from "./ui/connection-form";
import { SyncPolicy, defaultRules, validateRules, type SyncRules, type FileEntry } from "./sync/policy";
import { decodeProfile, type ClientView, type ClientConfiguration, type PendingProfile } from "./sync/client-profile";
import { clientName } from "../../protocol/src/client-profile";
import { canonical } from "../../protocol/src/model";

const configSchema = z.strictObject({ endpoint: z.string(), token: z.string().min(32), deviceId: z.string(), deviceName: z.string(), vaultId: z.string(), databaseId: z.string().regex(/^[a-f0-9]{64}$/) });
export default class ObsidianSyncPlugin extends Plugin {
  engine?: SyncEngine;
  autoSync = true;
  endpoint = "";
  rules: SyncRules = defaultRules();
  policy = new SyncPolicy(this.rules);
  clients: ClientView[] = [];
  private profileRevision?: number;
  private profileDirty = true;
  private profilePending?: PendingProfile;
  private remote?: Transport;
  private configTimer?: ReturnType<typeof setInterval>;
  private configStamp = "";
  private configScanning = false;
  private config?: z.infer<typeof configSchema>;
  private root = "";
  private port?: ObsidianVaultPort;
  private connectionRecord = "desktop-unlock.json";
  private restoreAllowed = true;
  private configuring = false;
  storageState = "未检查";
  eventState = "stopped";
  lastSyncAt = "";
  hostError = "";
  localPending = false;
  private db?: SyncDB;
  private statusEl?: HTMLElement;
  private work = new SerialWork();
  private automatic?: AutomaticSync;
  private events?: RemoteEvents;
  private remembered?: RememberedUnlock;
  private layoutReady = false;
  private disposed = false;
  private changeGeneration = 0;
  private lastStatus?: EngineStatus;
  private listeners = new Set<() => void>();
  deviceName = "";
  async onload(): Promise<void> {
    this.statusEl = this.addStatusBarItem(); this.statusEl.setText("ObsidianSync · 正在连接");
    this.addRibbonIcon("refresh-cw", "ObsidianSync 同步面板", () => new SyncOverview(this.app, this, () => new ConnectionModal(this.app, this).open()).open());
    this.addCommand({ id: "open-sync-panel", name: "打开同步面板", callback: () => new SyncOverview(this.app, this, () => new ConnectionModal(this.app, this).open()).open() });
    this.addCommand({ id: "configure-sync", name: "配置服务器与同步密钥", callback: () => new ConnectionModal(this.app, this).open() });
    this.addCommand({ id: "toggle-sync", name: "暂停 / 恢复同步", callback: () => { void this.setAutoSync(!this.autoSync).catch(error => new Notice(String(error))); } });
    this.addSettingTab(new SyncSettingTab(this.app, this));
    try {
      const root = `${this.app.vault.configDir}/obsidian-sync-local`;
      const marker = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/obsidian-sync-development.json`)) as { generatedBy?: string };
      if (marker.generatedBy !== "ObsidianSync desktop test setup") throw new Error("DEVELOPMENT_VAULT_REQUIRED");
      const config = configSchema.parse(JSON.parse(await this.app.vault.adapter.read(`${root}/device.json`)));
      this.config = config; this.root = root; this.deviceName = config.deviceName;
      const saved = connectionSettings(await this.loadData(), config.endpoint);
      this.endpoint = saved.endpoint; this.autoSync = saved.autoSync;
      this.rules = saved.rules; this.policy = new SyncPolicy(this.rules); this.deviceName = saved.clientName ?? config.deviceName;
      this.profileRevision = saved.profileRevision; this.profileDirty = saved.profileDirty; this.profilePending = saved.profilePending;
      this.connectionRecord = saved.record; this.restoreAllowed = saved.restoreAllowed;
      this.db = new SyncDB(`obsidian-sync-dev-${config.databaseId}`); await this.db.open();
      const remote = this.transport(this.endpoint); this.remote = remote;
      const port = new ObsidianVaultPort(this.app, root, () => this.policy); this.port = port;
      this.engine = new SyncEngine(this.db, remote, port, config.deviceId, config.vaultId, this.policy);
      try {
        this.remembered = this.unlockStore(this.endpoint, this.connectionRecord);
        this.storageState = "请填写服务器地址和同步密钥并保存";
      } catch (error) { this.storageState = `无法安全保存密钥：${String(error)}`; }
      this.automatic = new AutomaticSync(() => this.sync(false), error => { this.hostError = String(error); this.emit(); });
      this.connectEvents(remote);
      const changed = (file: { path: string }) => {
        if (port.isOwnWrite(file.path)) return;
        if (!port.inScope(file.path)) { this.emit(); return; }
        this.changeGeneration++; this.localPending = true; this.showPending(); this.automatic?.trigger("file");
      };
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("create", file => { if (file instanceof TFile) changed(file); }));
      this.registerEvent(this.app.vault.on("delete", changed));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        if (port.isOwnRename(oldPath, file.path)) return;
        changed(file);
        if (file instanceof TFile && this.engine?.unlocked) {
          void this.work.run(async () => {
            if (this.disposed || !this.engine?.unlocked) return;
            await this.engine.rename(port.logical(oldPath), port.logical(file.path));
          }).then(() => this.automatic?.trigger("rename"), error => { this.hostError = String(error); this.emit(); });
        }
      }));
      this.registerDomEvent(window, "online", () => { this.events?.reconnect(); this.automatic?.trigger("online", true); });
      this.registerDomEvent(window, "focus", () => this.automatic?.trigger("focus", true));
      this.registerDomEvent(document, "visibilitychange", () => { if (!document.hidden) this.automatic?.trigger("foreground", true); });
      this.app.workspace.onLayoutReady(() => { this.layoutReady = true; void this.startup(); });
    } catch (error) { this.statusEl.setText("ObsidianSync · 测试库配置未就绪"); new Notice(`ObsidianSync 未启动：${String(error)}`); }
  }
  private async startup(): Promise<void> {
    await this.work.run(async () => {
      if (this.disposed || !this.engine) return;
      if (this.restoreAllowed && this.remembered) {
        try {
          const material = await this.remembered.load();
          if (material && !this.disposed) { await this.engine.restoreRemembered(material); this.storageState = "配置已保存"; }
        } catch { this.storageState = "保存的密钥不可用，请重新填写并保存；原记录保留"; }
      }
      if (this.disposed) { this.engine.lock(); return; }
      this.publishStatus(await this.engine.status(), false); this.updateAutomation();
    });
  }
  onunload(): void {
    this.disposed = true; clearInterval(this.configTimer); this.configTimer = undefined; this.automatic?.stop(); this.events?.stop(); this.listeners.clear(); this.engine?.lock();
    void this.work.idle().finally(() => this.db?.close());
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  private updateAutomation(): void {
    if (!this.disposed && this.layoutReady && !this.configuring && this.autoSync && this.engine?.unlocked) {
      this.automatic?.start(); this.events?.start();
      if (!this.configTimer) this.configTimer = setInterval(() => { void this.pollConfiguration(); }, 2000);
    }
    else { clearInterval(this.configTimer); this.configTimer = undefined; this.automatic?.stop(); this.events?.stop(); }
  }
  private showPending(): void {
    if (!this.autoSync) this.statusEl?.setText("ObsidianSync · 已暂停同步");
    else if (this.lastStatus?.state === "needs-attention") this.statusEl?.setText("ObsidianSync · 需处理");
    else this.statusEl?.setText(this.engine?.unlocked ? "ObsidianSync · 有变更待核对" : "ObsidianSync · 请配置同步");
    this.emit();
  }
  private transport(endpoint: string): Transport {
    if (!this.config) throw new Error("DEVELOPMENT_VAULT_REQUIRED");
    return new Transport(endpoint, this.config.token, async r => {
      const response = await boundedRequest(requestUrl({ url: r.url, method: r.method, headers: r.headers, body: r.body?.slice().buffer, throw: false }));
      return { status: response.status, headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v])), bytes: new Uint8Array(response.arrayBuffer) };
    });
  }
  private unlockStore(endpoint: string, record: string): RememberedUnlock {
    if (!this.config) throw new Error("DEVELOPMENT_VAULT_REQUIRED");
    return new RememberedUnlock(this.app.vault.adapter, `${this.root}/${record}`, {
      vaultId: this.config.vaultId, deviceId: this.config.deviceId, databaseId: this.config.databaseId, endpoint,
    }, desktopProtector(Platform.isDesktop));
  }
  private connectEvents(remote: Transport): void {
    this.events?.stop();
    this.events = new RemoteEvents(remote, hint => {
      void this.db?.progress.get("progress").then(progress => {
        if (hint.type === "ready" || !progress || hint.epoch !== progress.epoch || hint.seq > progress.received) this.automatic?.trigger("remote");
      }).catch(() => { /* Unload closes DB after stopping the event source. */ });
    }, state => { this.eventState = state; this.emit(); });
  }
  async saveConnection(inputEndpoint: string, key: string, observe?: ConnectionObserver, proposedName = this.deviceName): Promise<void> {
    let step: ConnectionStep = "server";
    try {
      const endpoint = normalizeEndpoint(inputEndpoint.trim()); const name = clientName(proposedName);
      await this.work.run(async () => {
        if (!this.config || !this.db || !this.port || this.disposed) throw new Error("DEVELOPMENT_VAULT_REQUIRED");
        this.configuring = true; this.updateAutomation();
        const remote = this.transport(endpoint);
        const candidate = new SyncEngine(this.db, remote, this.port, this.config.deviceId, this.config.vaultId, this.policy);
        let installed = false;
        try {
          // Reuse a protected session when the saved-key input is left empty; never recover a plaintext passphrase.
          if (!key) {
            step = "key";
            const material = this.engine?.unlocked ? this.engine.rememberedMaterial() : this.restoreAllowed ? await this.remembered?.load() : null;
            if (!material) throw new Error("CONNECTION_KEY_REQUIRED");
            await candidate.restoreRemembered(material);
          }
          step = "server"; observe?.({ step, state: "running" });
          const authenticated = () => {
            observe?.({ step: "server", state: "passed" }); observe?.({ step: "authorization", state: "passed" });
            step = "key"; observe?.({ step, state: "running" });
          };
          // Only the handshake and local crypto are tested here. No files/queues/remote objects are changed.
          if (key) await candidate.unlock(key, authenticated); else await candidate.validateConnection(authenticated);
          if (this.engine?.unlocked && this.engine.rememberedMaterial().keyPackageFingerprint !== candidate.rememberedMaterial().keyPackageFingerprint) throw new Error("KEY_PACKAGE_CHANGED");
          observe?.({ step: "key", state: "passed" });
          if (this.disposed) throw new Error("PLUGIN_UNLOADED");
          step = "name"; observe?.({ step, state: "running" });
          const own = (await remote.devices()).find(row => row.id === this.config!.deviceId);
          if (!own) throw new Error("HANDSHAKE_MISMATCH");
          const configuration = this.configuration(name);
          const update = { name, expectedRevision: own.revision, ciphertext: candidate.sealProfile(own.revision + 1, configuration) };
          const receipt = await remote.putProfile(update);
          observe?.({ step: "name", state: "passed" });
          step = "storage"; observe?.({ step, state: "running" });
          const record = `connection-${randomId()}.json`;
          const remembered = this.unlockStore(endpoint, record);
          await remembered.save(candidate.rememberedMaterial());
          if (this.disposed) throw new Error("PLUGIN_UNLOADED");
          // Immutable protected records keep the previous configuration usable if saving the pointer fails.
          await this.saveData({ format: 3, autoSync: this.autoSync, endpoint, record, clientName: name, rules: this.rules, profileRevision: receipt.revision, profileDirty: false });
          if (this.disposed) throw new Error("PLUGIN_UNLOADED");
          this.engine?.lock(); this.engine = candidate; installed = true;
          this.endpoint = endpoint; this.remote = remote; this.deviceName = name; this.profileRevision = receipt.revision; this.profileDirty = false; this.profilePending = undefined; this.connectionRecord = record; this.restoreAllowed = true; this.remembered = remembered;
          this.storageState = "配置已保存"; this.hostError = ""; this.connectEvents(remote);
          observe?.({ step: "storage", state: "passed" });
        } finally {
          if (!installed) candidate.lock();
          this.configuring = false; this.updateAutomation();
          if (!this.disposed && this.engine) this.publishStatus(await this.engine.status(), false);
        }
      });
    } catch (error) {
      const failed = connectionFailure(error, step);
      if (failed.step === "authorization") observe?.({ step: "server", state: "passed" });
      observe?.({ step: failed.step, state: "failed", message: failed.message });
      throw error;
    }
  }
  async sync(notify = true): Promise<void> {
    await this.work.run(async () => {
      if (!this.engine || this.disposed || !this.autoSync || this.configuring) return;
      const generation = this.changeGeneration;
      try {
        let profileError = "";
        try { await this.flushProfile(); } catch (error) { profileError = `客户端配置快照未更新：${String(error)}`; }
        const status = await this.engine.sync();
        this.localPending = this.changeGeneration !== generation;
        this.lastSyncAt = new Date().toLocaleTimeString(); this.hostError = profileError; this.publishStatus(status, notify);
      } catch (error) { this.hostError = String(error); if (notify) new Notice(`同步暂停：${String(error)}`); this.emit(); }
    });
  }
  private publishStatus(status: EngineStatus, notify: boolean): void {
    this.lastStatus = status;
    const label = !this.autoSync ? "已暂停同步" : this.localPending && status.state === "complete" ? "有变更待核对"
      : { locked: "请配置同步", pending: "同步进行中", "needs-attention": "需处理", complete: "所选范围同步完成" }[status.state];
    this.statusEl?.setText(`ObsidianSync · ${label}`);
    if (notify) new Notice(`${label} · 待上传 ${status.outbox} · 待应用 ${status.inbox} · 冲突 ${status.conflicts}`);
    this.emit();
  }
  async resolveConflict(review: Review, selectedRevision: string, companionPath?: string, mergedBytes?: Uint8Array): Promise<void> {
    await this.work.run(async () => {
      if (!this.engine || this.disposed) throw new Error("DEVELOPMENT_VAULT_REQUIRED");
      if (!this.autoSync || this.configuring) throw new Error("请先恢复同步");
      try { if (mergedBytes) await this.engine.resolve(review, selectedRevision, companionPath, mergedBytes); else await this.engine.resolve(review, selectedRevision, companionPath); }
      finally { this.publishStatus(await this.engine.status(), false); }
    });
    this.automatic?.trigger("resolution", true);
  }
  async setAutoSync(enabled: boolean): Promise<void> {
    this.autoSync = enabled; this.profileDirty = true; this.updateAutomation();
    // Finish already-running work before reporting the pause as complete; queued sync jobs recheck autoSync.
    await this.work.run(async () => {
      await this.saveSettings();
      if (this.engine) this.publishStatus(await this.engine.status(), false); else this.emit();
    });
  }
  private configuration(name = this.deviceName): ClientConfiguration {
    const platform = Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "Desktop";
    return { format: 1, name, platform, pluginVersion: buildManifest.version, autoSync: this.autoSync, rules: this.rules };
  }
  async refreshClients(): Promise<ClientView[]> {
    if (!this.remote || !this.engine?.unlocked) throw new Error("请先保存连接配置");
    const rows = await this.remote.devices();
    const own = rows.find(row => row.id === this.config?.deviceId); if (own && !this.configuring) this.deviceName = own.name;
    this.clients = rows.map(row => {
      try { return { ...row, configuration: row.ciphertext ? decodeProfile(this.engine!.openProfile(row.id, row.revision, row.ciphertext), row.name) : undefined }; }
      catch { return { id: row.id, name: row.name, revision: row.revision, reportedAt: row.reportedAt, error: "此配置快照无法验证，原数据保留" }; }
    });
    return this.clients;
  }
  private async flushProfile(): Promise<void> {
    if (!this.remote || !this.engine?.unlocked || !this.config) return;
    const rows = await this.refreshClients(); const own = rows.find(r => r.id === this.config!.deviceId);
    if (!own) throw new Error("DEVICE_PROFILE_MISSING");
    if (this.profileRevision === undefined) { this.profileRevision = own.revision; this.deviceName = own.name; }
    if (own.configuration && (own.configuration.pluginVersion !== buildManifest.version || own.configuration.platform !== this.configuration().platform)) this.profileDirty = true;
    if (!this.profileDirty && !this.profilePending) return;
    if (!this.profilePending) {
      if (own.revision !== this.profileRevision) throw new Error("PROFILE_STALE: 请重新保存本机规则");
      this.profilePending = { name: this.deviceName, expectedRevision: this.profileRevision, ciphertext: this.engine.sealProfile(this.profileRevision + 1, this.configuration()) };
    }
    await this.saveSettings();
    const pending = this.profilePending;
    const row = await this.remote.putProfile(pending);
    const uploaded = this.engine.openProfile(this.config.deviceId, row.revision, pending.ciphertext);
    this.profileRevision = row.revision; this.profilePending = undefined; this.profileDirty = canonical(uploaded) !== canonical(this.configuration());
    await this.saveSettings();
  }
  async setRules(input: SyncRules): Promise<void> {
    const rules = validateRules(input); const policy = new SyncPolicy(rules);
    await this.work.run(async () => {
      const prior = this.rules; this.rules = rules; this.profileDirty = true;
      try { await this.saveSettings(); } catch (error) { this.rules = prior; throw error; }
      this.policy = policy; this.engine?.setPolicy(policy); this.configStamp = ""; this.emit();
    });
    this.automatic?.trigger("rules", true);
    void this.work.run(async () => { try { await this.flushProfile(); } catch (error) { this.hostError = `配置已在本机保存，快照待上报：${String(error)}`; this.emit(); } });
  }
  async inventory(): Promise<FileEntry[]> { if (!this.port) return []; return this.port.inventory(); }
  async excludedChildren(path: string): Promise<FileEntry[]> { return this.port?.excludedChildren(path) ?? []; }
  get configurationReloadNeeded(): boolean { return this.port?.configurationChanged ?? false; }
  private async pollConfiguration(): Promise<void> {
    if (this.configScanning || this.disposed || !this.autoSync || !this.port) return;
    this.configScanning = true;
    try { const stamp = await this.port.configurationStamp(); if (stamp !== this.configStamp) { this.configStamp = stamp; this.automatic?.trigger("configuration"); } }
    catch (error) { this.hostError = `配置扫描失败：${String(error)}`; this.emit(); }
    finally { this.configScanning = false; }
  }
  async saveSettings(): Promise<void> {
    await this.saveData({ format: 3, autoSync: this.autoSync, endpoint: this.endpoint, record: this.connectionRecord, restoreAllowed: this.restoreAllowed, clientName: this.deviceName, rules: this.rules, profileRevision: this.profileRevision ?? 0, profileDirty: this.profileDirty, ...(this.profilePending ? { profilePending: this.profilePending } : {}) });
  }

}
class SyncSettingTab extends PluginSettingTab {
  private cleanup?: () => void;
  constructor(app: App, private plugin: ObsidianSyncPlugin) { super(app, plugin); }
  display(): void {
    this.cleanup?.();
    this.containerEl.empty();
    this.cleanup = connectionForm(this.containerEl.createDiv(), this.plugin);
  }
  hide(): void { this.cleanup?.(); this.cleanup = undefined; }
}
class ConnectionModal extends Modal {
  private cleanup?: () => void;
  constructor(app: App, private plugin: ObsidianSyncPlugin) { super(app); }
  onOpen(): void { this.modalEl.addClass("oss-connection-modal"); this.cleanup = connectionForm(this.contentEl.createDiv(), this.plugin); }
  onClose(): void { this.cleanup?.(); this.cleanup = undefined; this.contentEl.empty(); }
}
