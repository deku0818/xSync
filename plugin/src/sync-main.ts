import { timerHost, type TimerHandle } from "./runtime/timers";
// Based on obsidianmd/obsidian-sample-plugin, commit 07ceb81d1fb3384af611ebf665a1ec42a7e5926d (0BSD).
import { Modal, Notice, Platform, Plugin, TFile, requestUrl, type App } from "obsidian";
import { z } from "zod";
import buildManifest from "../../manifest.json";
import { SyncEngine, type EngineStatus, type Review } from "./sync/engine";
import { SyncDB } from "./sync/store";
import { ObsidianVaultPort } from "./sync/vault-port";
import { Transport, boundedRequest, normalizeEndpoint } from "./sync/transport";
import { SyncOverview } from "./ui/sync-panels";
import { AutomaticSync, RemoteEvents, SerialWork } from "./sync/realtime";
import { desktopProtector } from "./desktop/protector";
import { iosProtector } from "./mobile/ios-protector";
import { RememberedUnlock, type StoredMaterial } from "./desktop/remembered-unlock";
import { randomId, fingerprint, VaultCrypto } from "./sync/crypto";
import { enrollConnection } from "./sync/enrollment";
import { connectionSettings } from "./sync/connection-settings";
import { connectionFailure, type ConnectionObserver, type ConnectionStep } from "./sync/connection-check";
import { connectionForm } from "./ui/connection-form";
import { SyncSettingTab } from "./ui/settings-tab";
import { SyncPolicy, defaultRules, validateRules, type SyncRules, type FileEntry } from "./sync/policy";
import { decodeProfile, type ClientView, type ClientConfiguration, type PendingProfile } from "./sync/client-profile";
import { clientName } from "../../protocol/src/client-profile";
import { canonical } from "../../protocol/src/model";

const configSchema = z.strictObject({ endpoint: z.string().default(""), developmentEndpoint: z.string().optional(), token: z.union([z.string().min(32).max(128), z.literal("")]).default(""), deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), deviceName: z.string().default(""), vaultId: z.string().default(""), databaseId: z.string().regex(/^[a-f0-9]{64}$/) });
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
  private configTimer?: TimerHandle;
  private configStamp = "";
  private configScanning = false;
  private config?: z.infer<typeof configSchema>;
  private root = "";
  private port?: ObsidianVaultPort;
  private connectionRecord = "desktop-unlock.json";
  private restoreAllowed = true;
  private configuring = false;
  hasSavedKey = false;
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
    this.statusEl = this.addStatusBarItem(); this.statusEl.setText("xSync · 正在连接");
    this.addRibbonIcon("refresh-cw", "xSync 同步面板", () => new SyncOverview(this.app, this, () => new ConnectionModal(this.app, this).open()).open());
    this.addCommand({ id: "open-sync-panel", name: "打开同步面板", callback: () => new SyncOverview(this.app, this, () => new ConnectionModal(this.app, this).open()).open() });
    this.addCommand({ id: "configure-sync", name: "配置服务器与同步密钥", callback: () => new ConnectionModal(this.app, this).open() });
    this.addCommand({ id: "toggle-sync", name: "暂停 / 恢复同步", callback: () => { void this.setAutoSync(!this.autoSync).catch(error => new Notice(String(error))); } });
    this.addSettingTab(new SyncSettingTab(this.app, this));
    try {
      const root = `${this.app.vault.configDir}/obsidian-sync-local`;
      const adapter = this.app.vault.adapter;
      const savedData: unknown = await this.loadData();
      const markerPath = `${this.app.vault.configDir}/obsidian-sync-development.json`;
      let development = false;
      if (await adapter.exists(markerPath)) {
        const marker: unknown = JSON.parse(await adapter.read(markerPath));
        development = z.object({ generatedBy: z.literal("ObsidianSync desktop test setup") }).safeParse(marker).success;
      }
      if (!await adapter.exists(root)) await adapter.mkdir(root);
      const identityPath = `${root}/device.json`;
      if (!await adapter.exists(identityPath)) {
        if (savedData && typeof savedData === "object" && "endpoint" in savedData && savedData.endpoint) throw new Error("LOCAL_IDENTITY_MISSING");
        const identity = JSON.stringify({ deviceId: randomId(), databaseId: randomId() });
        await adapter.write(identityPath, identity);
        if (await adapter.read(identityPath) !== identity) throw new Error("IDENTITY_WRITE_INCOMPLETE");
      }
      const config = configSchema.parse(JSON.parse(await adapter.read(identityPath)));
      if (!development && (config.developmentEndpoint || config.token)) throw new Error("DEVELOPMENT_FIXTURE_REQUIRES_MARKER");
      this.config = config; this.root = root; this.deviceName = config.deviceName;
      const saved = connectionSettings(savedData, config.endpoint, config.developmentEndpoint);
      config.vaultId = saved.vaultId ?? config.vaultId;
      this.endpoint = saved.endpoint; this.autoSync = saved.autoSync;
      this.rules = saved.rules; this.policy = new SyncPolicy(this.rules); this.deviceName = saved.clientName ?? config.deviceName;
      this.profileRevision = saved.profileRevision; this.profileDirty = saved.profileDirty; this.profilePending = saved.profilePending;
      this.connectionRecord = saved.record; this.restoreAllowed = saved.restoreAllowed;
      this.db = new SyncDB(`obsidian-sync-dev-${config.databaseId}`); await this.db.open();
      const remote = this.endpoint ? this.transport(this.endpoint) : undefined; this.remote = remote;
      const port = new ObsidianVaultPort(this.app, root, () => this.policy); this.port = port;
      if (remote && config.vaultId) this.engine = new SyncEngine(this.db, remote, port, config.deviceId, config.vaultId, this.policy);
      try {
        if (this.endpoint && config.vaultId) this.remembered = this.unlockStore(this.endpoint, this.connectionRecord);
        this.hasSavedKey = this.restoreAllowed && (this.remembered ? await this.remembered.hasRecord() : false);
        this.storageState = "请填写服务器地址和同步密钥并保存";
      } catch (error) { this.storageState = `无法安全保存密钥：${String(error)}`; }
      this.automatic = new AutomaticSync(() => this.sync(false), error => { this.hostError = String(error); this.emit(); });
      if (remote) this.connectEvents(remote);
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
      this.registerDomEvent(window, "online", () => { this.events?.reconnect(); this.wake("online"); });
      this.registerDomEvent(window, "focus", () => this.wake("focus"));
      this.registerDomEvent(document, "visibilitychange", () => { if (!document.hidden) this.wake("foreground"); });
      if (!this.engine) this.statusEl.setText("xSync · 请配置同步");
      this.app.workspace.onLayoutReady(() => { this.layoutReady = true; this.wake("startup"); });
    } catch (error) { this.statusEl.setText("xSync · 配置未就绪"); new Notice(`xSync 未启动：${String(error)}`); }
  }
  private wake(reason: string): void {
    if (this.disposed || !this.layoutReady) return;
    void this.startup().then(() => { if (!this.disposed) this.automatic?.trigger(reason, true); }, error => {
      this.hostError = String(error); this.emit();
    });
  }
  private async startup(): Promise<void> {
    await this.work.run(async () => {
      if (this.disposed || !this.engine) return;
      if (!this.engine.unlocked && this.restoreAllowed && this.remembered) {
        try {
          const material = await this.remembered.load();
          if (material && !this.disposed) { this.config!.token = material.token ?? this.config!.token; this.remote?.setToken(this.config!.token); await this.engine.restoreRemembered(material); this.hasSavedKey = true; this.storageState = "配置已保存"; }
          else if (!material) this.hasSavedKey = false;
        } catch { this.storageState = "暂时无法读取保存的密钥；回到前台后重试，原记录保留。持续失败时请重新填写并保存"; }
      }
      if (this.disposed) { this.engine.lock(); return; }
      this.publishStatus(await this.engine.status(), false); this.updateAutomation();
    });
  }
  onunload(): void {
    this.disposed = true; timerHost().clearInterval(this.configTimer); this.configTimer = undefined; this.automatic?.stop(); this.events?.stop(); this.listeners.clear(); this.engine?.lock();
    void this.work.idle().finally(() => this.db?.close());
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  private updateAutomation(): void {
    if (!this.disposed && this.layoutReady && !this.configuring && this.autoSync && this.engine?.unlocked) {
      this.automatic?.start(); this.events?.start();
      if (!this.configTimer) this.configTimer = timerHost().setInterval(() => { void this.pollConfiguration(); }, 2000);
    }
    else { timerHost().clearInterval(this.configTimer); this.configTimer = undefined; this.automatic?.stop(); this.events?.stop(); }
  }
  private showPending(): void {
    if (!this.autoSync) this.statusEl?.setText("xSync · 已暂停同步");
    else if (this.lastStatus?.state === "needs-attention") this.statusEl?.setText("xSync · 需处理");
    else this.statusEl?.setText(this.engine?.unlocked ? "xSync · 有变更待核对" : "xSync · 请配置同步");
    this.emit();
  }
  private transport(endpoint: string): Transport {
    if (!this.config) throw new Error("LOCAL_IDENTITY_NOT_READY");
    return new Transport(endpoint, this.config.token, async r => {
      const response = await boundedRequest(requestUrl({ url: r.url, method: r.method, headers: r.headers, body: r.body?.slice().buffer, throw: false }));
      return { status: response.status, headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v])), bytes: new Uint8Array(response.arrayBuffer) };
    }, this.config.developmentEndpoint);
  }
  private unlockStore(endpoint: string, record: string, vaultId = this.config?.vaultId ?? ""): RememberedUnlock {
    if (!this.config) throw new Error("LOCAL_IDENTITY_NOT_READY");
    const identity = {
      vaultId, deviceId: this.config.deviceId, databaseId: this.config.databaseId, endpoint,
    };
    const protector = Platform.isDesktop ? desktopProtector(true) : iosProtector(Platform.isIosApp, identity);
    return new RememberedUnlock(this.app.vault.adapter, `${this.root}/${record}`, identity, protector);
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
      const endpoint = normalizeEndpoint(inputEndpoint.trim(), this.config?.developmentEndpoint); const name = clientName(proposedName);
      await this.work.run(async () => {
        if (!this.config || !this.db || !this.port || this.disposed) throw new Error("LOCAL_IDENTITY_NOT_READY");
        this.configuring = true; this.updateAutomation();
        const remote = this.transport(endpoint);
        let candidate: SyncEngine | undefined;
        let installed = false;
        let vaultId = this.config.vaultId;
        let token = this.config.token;
        try {
          if (!key && !this.hasSavedKey && !this.engine?.unlocked) { step = "key"; throw new Error("CONNECTION_KEY_REQUIRED"); }
          if (!token || !this.config.endpoint) {
            let previous: StoredMaterial | null = this.engine?.unlocked ? { ...this.engine.rememberedMaterial(), token: token || undefined } : null;
            if (!previous && this.restoreAllowed && this.remembered) {
              try { previous = await this.remembered.load(); } catch (error) { if (!key) { step = "storage"; throw error; } }
            }
            const enrollment = await enrollConnection({ remote, vaultId, key, name, deviceId: this.config.deviceId, previous,
              assertActive: () => { if (this.disposed) throw new Error("PLUGIN_UNLOADED"); },
              stage: next => {
                if (next === "key") observe?.({ step: "server", state: "passed" });
                if (next === "authorization") observe?.({ step: "key", state: "passed" });
                step = next; observe?.({ step, state: "running" });
              },
              pendingStore: async id => this.unlockStore(endpoint, `pending-${await fingerprint(new TextEncoder().encode(canonical({ endpoint, vaultId: id, deviceId: this.config!.deviceId, databaseId: this.config!.databaseId })))}.json`, id),
              validate: async (material, epoch) => {
                const progress = await this.db!.progress.get("progress");
                if (progress && (progress.vaultId !== material.vaultId || progress.epoch !== epoch)) throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
                const keys = await VaultCrypto.restore(material.vaultId, material.session);
                try { for (const revision of await this.db!.revisions.toArray()) keys.manifest(revision); }
                catch { throw new Error("LOCAL_KEY_ANCHOR_MISMATCH"); } finally { keys.close(); }
              },
            });
            if (this.disposed) throw new Error("PLUGIN_UNLOADED");
            vaultId = enrollment.vaultId; token = enrollment.material.token!;
            candidate = new SyncEngine(this.db, remote, this.port, this.config.deviceId, vaultId, this.policy);
            await candidate.restoreRemembered(enrollment.material);
            await candidate.validateConnection();
            observe?.({ step: "authorization", state: "passed" });
          } else {
            candidate = new SyncEngine(this.db, remote, this.port, this.config.deviceId, vaultId, this.policy);
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
            // Legacy generated fixtures retain their pre-authorized handshake path.
            if (key) await candidate.unlock(key, authenticated); else await candidate.validateConnection(authenticated);
          }
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
          const remembered = this.unlockStore(endpoint, record, vaultId);
          await remembered.save({ ...candidate.rememberedMaterial(), token });
          if (this.disposed) throw new Error("PLUGIN_UNLOADED");
          // Immutable protected records keep the previous configuration usable if saving the pointer fails.
          await this.saveData({ format: 4, vaultId, autoSync: this.autoSync, endpoint, record, restoreAllowed: true, clientName: name, rules: this.rules, profileRevision: receipt.revision, profileDirty: false });
          if (this.disposed) throw new Error("PLUGIN_UNLOADED");
          this.engine?.lock(); this.engine = candidate; installed = true; this.config.vaultId = vaultId; this.config.token = token;
          this.endpoint = endpoint; this.remote = remote; this.deviceName = name; this.profileRevision = receipt.revision; this.profileDirty = false; this.profilePending = undefined; this.connectionRecord = record; this.restoreAllowed = true; this.remembered = remembered;
          this.hasSavedKey = true;
          this.storageState = "配置已保存"; this.hostError = ""; this.connectEvents(remote);
          observe?.({ step: "storage", state: "passed" });
        } finally {
          if (!installed) candidate?.lock();
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
    this.statusEl?.setText(`xSync · ${label}`);
    if (notify) new Notice(`${label} · 待上传 ${status.outbox} · 待应用 ${status.inbox} · 冲突 ${status.conflicts}`);
    this.emit();
  }
  async resolveConflict(review: Review, selectedRevision: string, companionPath?: string, mergedBytes?: Uint8Array): Promise<void> {
    await this.work.run(async () => {
      if (!this.engine || this.disposed) throw new Error("LOCAL_IDENTITY_NOT_READY");
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
      catch { return { id: row.id, name: row.name, revision: row.revision, reportedAt: row.reportedAt, revoked: row.revoked, error: "此配置快照无法验证，原数据保留" }; }
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
    await this.saveData({ format: 4, vaultId: this.config?.vaultId ?? "", autoSync: this.autoSync, endpoint: this.endpoint, record: this.connectionRecord, restoreAllowed: this.restoreAllowed, clientName: this.deviceName, rules: this.rules, profileRevision: this.profileRevision ?? 0, profileDirty: this.profileDirty, ...(this.profilePending ? { profilePending: this.profilePending } : {}) });
  }

}
class ConnectionModal extends Modal {
  private cleanup?: () => void;
  constructor(app: App, private plugin: ObsidianSyncPlugin) { super(app); }
  onOpen(): void { this.modalEl.addClass("oss-connection-modal"); this.cleanup = connectionForm(this.contentEl.createDiv(), this.plugin); }
  onClose(): void { this.cleanup?.(); this.cleanup = undefined; this.contentEl.empty(); }
}
