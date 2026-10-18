// Based on obsidianmd/obsidian-sample-plugin, commit 07ceb81d1fb3384af611ebf665a1ec42a7e5926d (0BSD).
import { Modal, Notice, Platform, Plugin, TFile, getLanguage, type Command, type App } from "obsidian";
import { z } from "zod";

import { I18n, type LanguagePreference } from "./i18n";

import buildManifest from "../../manifest.json";
import { accessKeySchema, type ManagedUser, type ManagedVault } from "../../protocol/src/access";
import { AccessClient } from "./sync/access-client";
import { clientName } from "../../protocol/src/client-profile.js";
import { canonical } from "../../protocol/src/model.js";
import { desktopProtector } from "./desktop/protector.js";
import { RememberedUnlock, type StoredMaterial } from "./desktop/remembered-unlock.js";
import { iosProtector } from "./mobile/ios-protector.js";
import { timerHost, type TimerHandle } from "./runtime/timers.js";
import { decodeProfile, type ClientView, type ClientConfiguration, type PendingProfile } from "./sync/client-profile.js";
import { connectionFailure, type ConnectionObserver, type ConnectionStep } from "./sync/connection-check.js";
import { connectionSettings } from "./sync/connection-settings.js";
import { randomId, fingerprint, VaultCrypto } from "./sync/crypto.js";
import { SyncEngine, type EngineStatus, type Review } from "./sync/engine.js";
import { enrollConnection } from "./sync/enrollment.js";
import { obsidianHTTP } from "./sync/obsidian-http.js";
import { SyncPolicy, defaultRules, validateRules, type SyncRules, type FileEntry } from "./sync/policy.js";
import { AutomaticSync, RemoteEvents, SerialWork } from "./sync/realtime.js";
import { SyncDB } from "./sync/store.js";
import { Transport, normalizeEndpoint } from "./sync/transport.js";
import { ObsidianVaultPort } from "./sync/vault-port.js";
import { connectionForm } from "./ui/connection-form.js";
import { SyncSettingTab } from "./ui/settings-tab.js";
import { SyncOverview } from "./ui/sync-panels.js";
import { syncPresentation } from "./ui/sync-status.js";

const configSchema = z.strictObject({ endpoint: z.string().default(""), developmentEndpoint: z.string().optional(), token: z.union([z.string().min(32).max(128), z.literal("")]).default(""), deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), deviceName: z.string().default(""), vaultId: z.string().default(""), databaseId: z.string().regex(/^[a-f0-9]{64}$/) });
export default class ObsidianSyncPlugin extends Plugin {
  readonly i18n = new I18n("auto", getLanguage);
  private localizedCommands: { source: string; prefix: string; command: Command }[] = [];
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
  private configStamp = new Map<string, string>();
  private configScanning = false;
  private config?: z.infer<typeof configSchema>;
  private root = "";
  private port?: ObsidianVaultPort;
  private connectionRecord = "desktop-unlock.json";
  private restoreAllowed = true;
  private configuring = false;
  hasSavedKey = false;
  accessSaved = false;
  accessUser?: ManagedUser;
  accessibleVaults: ManagedVault[] = [];
  vaultName = "";
  private accessRecord?: string;
  private accessUserId?: string;
  get localVaultName(): string { return this.app.vault.getName(); }
  get boundVaultId(): string { return this.config?.vaultId ?? ""; }

  eventState = "stopped";
  hostError = "";
  localPending = false;
  syncing = false;
  private statusTimer?: TimerHandle;
  private db?: SyncDB;
  private statusEl?: HTMLElement;
  private ribbonEl?: HTMLElement;
  private statusPanel?: SyncOverview;
  private work = new SerialWork();
  private automatic?: AutomaticSync;
  private events?: RemoteEvents;
  private remembered?: RememberedUnlock;
  private layoutReady = false;
  private disposed = false;
  private changeGeneration = 0;
  private lastFullCheck = 0;
  private lastStatus?: EngineStatus;
  private listeners = new Set<() => void>();
  deviceName = "";
  async onload(): Promise<void> {
    const t = this.i18n.t;
    this.statusEl = this.addStatusBarItem(); this.statusEl.setText(t("xSync · 正在连接"));
    this.statusEl.addClass("oss-status-bar"); this.statusEl.setAttribute("role", "button"); this.statusEl.tabIndex = 0;
    this.registerDomEvent(this.statusEl, "click", () => this.openStatus(this.statusEl));
    this.registerDomEvent(this.statusEl, "keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.openStatus(this.statusEl); } });
    this.ribbonEl = this.addRibbonIcon("cloud", t("xSync 同步状态"), () => this.openStatus());
    this.ribbonEl.addClass("oss-sync-ribbon");
    this.addUiCommand({ id: "open-sync-panel", name: "查看同步状态", callback: () => this.openStatus() });
    this.addUiCommand({ id: "configure-sync", name: "配置服务器、访问 key 与同步库", callback: () => new ConnectionModal(this.app, this).open() });
    this.addUiCommand({ id: "toggle-sync", name: "暂停 / 恢复同步", callback: () => { void this.setAutoSync(!this.autoSync).catch(error => new Notice(t(String(error)))); } });
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
      this.i18n.preference = saved.language;
      this.updateCommandLanguage();
      config.vaultId = saved.vaultId ?? config.vaultId;
      this.endpoint = saved.endpoint; this.autoSync = saved.autoSync;
      this.rules = saved.rules; this.policy = new SyncPolicy(this.rules); this.deviceName = saved.clientName ?? config.deviceName;
      this.profileRevision = saved.profileRevision; this.profileDirty = saved.profileDirty; this.profilePending = saved.profilePending;
      this.connectionRecord = saved.record; this.restoreAllowed = saved.restoreAllowed;
      this.accessRecord = saved.accessRecord; this.accessUserId = saved.userId; this.vaultName = saved.vaultName ?? "";
      if (this.accessRecord) this.accessSaved = await this.unlockStore(this.endpoint, this.accessRecord, "server-access").hasRecord();
      this.db = new SyncDB(`obsidian-sync-dev-${config.databaseId}`); await this.db.open();
      const remote = this.endpoint && config.vaultId ? this.transport(this.endpoint) : undefined; this.remote = remote;
      const port = new ObsidianVaultPort(this.app, root, () => this.policy); this.port = port;
      if (remote && config.vaultId) this.engine = new SyncEngine(this.db, remote, port, config.deviceId, config.vaultId, this.policy);
      try {
        if (this.endpoint && config.vaultId) this.remembered = this.unlockStore(this.endpoint, this.connectionRecord);
        this.hasSavedKey = this.restoreAllowed && (this.remembered ? await this.remembered.hasRecord() : false);
      } catch { /* Saving a connection reports unavailable secure storage through its observer. */ }
      this.automatic = new AutomaticSync(full => this.sync(false, full || Date.now() - this.lastFullCheck >= 300000), error => { this.hostError = String(error); this.emit(); });
      if (remote) this.connectEvents(remote);
      const changed = (file: { path: string }, full = false) => {
        if (port.isOwnWrite(file.path)) return;
        if (!port.inScope(file.path)) { this.emit(); return; }
        this.changeGeneration++; this.localPending = true; this.showPending();
        if (full) { this.automatic?.trigger("foreground", true); return; }
        void this.db!.markDirty(port.logical(file.path)).then(() => this.automatic?.trigger("file"), error => { this.hostError = String(error); this.automatic?.trigger("foreground", true); this.emit(); });
      };
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("create", file => { if (file instanceof TFile) changed(file); }));
      this.registerEvent(this.app.vault.on("delete", file => changed(file, !(file instanceof TFile))));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        if (port.isOwnRename(oldPath, file.path)) return;
        changed(file, !(file instanceof TFile));
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
      if (!this.engine) this.statusEl.setText(t("xSync · 请配置同步"));
      this.app.workspace.onLayoutReady(() => { this.layoutReady = true; this.wake("startup"); });
    } catch (error) { this.statusEl.setText(t("xSync · 配置未就绪")); new Notice(t("xSync 未启动：{0}", String(error))); }
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
          if (material && !this.disposed) { this.config!.token = material.token ?? this.config!.token; this.remote?.setToken(this.config!.token); await this.engine.restoreRemembered(material); this.hasSavedKey = true; }
          else if (!material) this.hasSavedKey = false;
        } catch { /* Preserve the protected record and retry on the next foreground wake. */ }
      }
      if (this.disposed) { this.engine.lock(); return; }
      if (this.engine.unlocked) await this.cleanupConnectionRecords();
      this.publishStatus(await this.engine.status(), false); this.updateAutomation();
    });
  }
  onunload(): void {
    this.statusPanel?.close();
    timerHost().clearInterval(this.statusTimer); this.statusTimer = undefined;
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
    this.renderStatusBar();
    this.emit();
  }
  private openStatus(anchor?: HTMLElement): void {
    this.statusPanel?.close();
    this.statusPanel = new SyncOverview(this.app, this, () => new ConnectionModal(this.app, this).open(), anchor);
    this.statusPanel.open();
  }
  private transport(endpoint: string): Transport {
    if (!this.config) throw new Error("LOCAL_IDENTITY_NOT_READY");
    return new Transport(endpoint, this.config.token, obsidianHTTP, this.config.developmentEndpoint, this.accessRecord ? this.config.vaultId : undefined);
  }
  private unlockStore(endpoint: string, record: string, vaultId = this.config?.vaultId ?? ""): RememberedUnlock {
    if (!this.config) throw new Error("LOCAL_IDENTITY_NOT_READY");
    const identity = {
      vaultId, deviceId: this.config.deviceId, databaseId: this.config.databaseId, endpoint,
    };
    const protector = Platform.isDesktop ? desktopProtector(true) : iosProtector(Platform.isIosApp, identity);
    return new RememberedUnlock(this.app.vault.adapter, `${this.root}/${record}`, identity, protector);
  }
  private async cleanupConnectionRecords(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      let active: StoredMaterial | null | undefined;
      const listing = await adapter.list(this.root);
      const names = new Set(listing.files.filter(path => path.startsWith(`${this.root}/`)).map(path => path.slice(this.root.length + 1).replace(/\.retiring$/, "")));
      for (const name of names) {
        if (/^access-[a-f0-9]{64}\.json$/.test(name)) {
          if (!this.accessRecord || name === this.accessRecord) continue;
          try {
            const identity = await this.accessStore(this.endpoint, name).retirementIdentity();
            if (identity) await this.unlockStore(identity.endpoint, name, identity.vaultId).retire(this.accessStore());
          } catch { /* Uncertain or active access records remain protected. */ }
          continue;
        }
        if (name === this.connectionRecord ||
            !/^(?:(?:connection|pending)-[a-f0-9]{64}|desktop-unlock)\.json$/.test(name)) continue;
        if (!active) {
          active = await this.remembered?.load();
          if (!active?.token) return;
        }
        try {
          const record = this.unlockStore(this.endpoint, name);
          const retirement = await record.retirementIdentity();
          if (retirement) {
            await this.unlockStore(retirement.endpoint, name, retirement.vaultId).retire(this.remembered);
            continue;
          }
          const material = await record.load();
          // An unreferenced candidate can still be the only receipt for a rotated token.
          // Retire only disabled records or credentials already held by the durable active record.
          if (material && (
            material.token !== active.token ||
            material.keyPackageFingerprint !== active.keyPackageFingerprint ||
            canonical(material.session) !== canonical(active.session)
          )) continue;
          await record.retire(this.remembered);
        } catch { /* Keep uncertain records; retry after the next successful restore/save. */ }
      }
    } catch { /* Housekeeping must not invalidate an installed protected connection. */ }
  }
  private connectEvents(remote: Transport): void {
    this.events?.stop();
    this.events = new RemoteEvents(remote, hint => {
      void this.db?.progress.get("progress").then(progress => {
        if (hint.type === "ready" || !progress || hint.epoch !== progress.epoch || hint.seq > progress.received) this.automatic?.trigger("remote");
      }).catch(() => { /* Unload closes DB after stopping the event source. */ });
    }, state => { this.eventState = state; this.emit(); });
  }
  private accessStore(endpoint = this.endpoint, record = this.accessRecord): RememberedUnlock {
    if (!record) throw new Error("ACCESS_KEY_REQUIRED");
    return this.unlockStore(endpoint, record, "server-access");
  }
  private async loadAccessClient(): Promise<AccessClient> {
    const access = await this.accessStore().loadAccess();
    if (!access || access.userId !== this.accessUserId) throw new Error("ACCESS_KEY_REQUIRED");
    return new AccessClient(access.endpoint, access.key, obsidianHTTP);
  }
  async authorizeServer(inputEndpoint: string, key: string, proposedName: string, observe?: ConnectionObserver): Promise<void> {
    let step: ConnectionStep = "server";
    try {
      const endpoint = normalizeEndpoint(inputEndpoint.trim()), name = clientName(proposedName);
      await this.work.run(async () => {
        if (!this.config || !this.db || !this.port || this.disposed) throw new Error("LOCAL_IDENTITY_NOT_READY");
        if (this.boundVaultId && (!this.accessRecord || endpoint !== this.endpoint)) throw new Error("USE_NEW_LOCAL_VAULT");
        this.configuring = true; this.updateAutomation();
        try {
          if (!key.trim() && endpoint !== this.endpoint) throw new Error("ACCESS_KEY_REQUIRED");
          const prior = !key.trim() ? await this.accessStore().loadAccess() : null;
          const parsed = accessKeySchema.safeParse(key.trim() || prior?.key);
          if (!parsed.success) throw new Error("ACCESS_KEY_INVALID");
          const value = parsed.data;
          const client = new AccessClient(endpoint, value, obsidianHTTP);
          observe?.({ step: "server", state: "running" });
          const connection = await client.connection();
          observe?.({ step: "server", state: "passed" }); step = "authorization";
          observe?.({ step, state: "passed" });
          if (this.boundVaultId && this.accessUserId && this.accessUserId !== connection.user.id) throw new Error("USE_NEW_LOCAL_VAULT");
          step = "storage"; observe?.({ step, state: "running" });
          const record = `access-${randomId()}.json`, protectedAccess = this.accessStore(endpoint, record);
          await protectedAccess.saveAccess({ endpoint, userId: connection.user.id, key: value });
          if (this.disposed) throw new Error("PLUGIN_UNLOADED");
          let material: StoredMaterial | null | undefined;
          if (this.boundVaultId) {
            const vault = connection.vaults.find(vault => vault.id === this.boundVaultId);
            if (!vault) throw new Error("VAULT_NOT_FOUND");
            try { material = this.engine?.unlocked ? this.engine.rememberedMaterial() : await this.remembered?.load(); }
            catch { /* Keep unreadable decryption material; the user may unlock again with the vault password. */ }
            if (material) await this.installManaged(client, vault, material, name, endpoint, record, connection.user.id, connection.user.keyRevision, next => { step = next; observe?.({ step: next, state: "running" }); });
          }
          if (!material) await this.saveAccessPointer(endpoint, record, connection.user.id, name, protectedAccess);
          this.accessUser = connection.user; this.accessibleVaults = connection.vaults; this.accessSaved = true; this.hostError = "";
          observe?.({ step: "storage", state: "passed" });
        } finally { this.configuring = false; this.updateAutomation(); this.emit(); }
      });
    } catch (error) { const failed = connectionFailure(error, step, this.i18n.t); observe?.({ step: failed.step, state: "failed", message: failed.message }); throw error; }
  }
  private async saveAccessPointer(endpoint: string, record: string, userId: string, name: string, protectedAccess: RememberedUnlock): Promise<void> {
    const previous = this.accessRecord ? this.accessStore() : undefined;
    await previous?.prepareRetirement();
    if (this.disposed) throw new Error("PLUGIN_UNLOADED");
    await this.saveData({ format: 4, language: this.i18n.preference, vaultId: this.boundVaultId, vaultName: this.vaultName, autoSync: this.autoSync, endpoint, record: this.connectionRecord, accessRecord: record, userId, restoreAllowed: true, clientName: name, rules: this.rules, profileRevision: this.profileRevision ?? 0, profileDirty: this.profileDirty });
    this.endpoint = endpoint; this.accessRecord = record; this.accessUserId = userId; this.deviceName = name;
    try { await previous?.retire(protectedAccess); } catch { /* Startup resumes journaled retirement. */ }
  }
  async refreshVaults(): Promise<void> {
    const client = await this.loadAccessClient(), connection = await client.connection();
    if (connection.user.id !== this.accessUserId) throw new Error("UNLOCK_IDENTITY_MISMATCH");
    this.accessUser = connection.user; this.accessibleVaults = connection.vaults;
  }
  async connectManagedVault(vaultId: string, password: string, createName?: string, stage?: (step: ConnectionStep) => void): Promise<void> {
    await this.work.run(async () => {
      if (!this.config || !this.db || !this.port || this.disposed) throw new Error("LOCAL_IDENTITY_NOT_READY");
      if (this.boundVaultId && this.boundVaultId !== vaultId) throw new Error("USE_NEW_LOCAL_VAULT");
      this.configuring = true; this.updateAutomation();
      try {
        stage?.("storage");
        const client = await this.loadAccessClient(); stage?.("server");
        const connection = await client.connection();
        if (connection.user.id !== this.accessUserId) throw new Error("UNLOCK_IDENTITY_MISMATCH");
        let vault: ManagedVault, material: StoredMaterial;
        stage?.("key");
        if (createName !== undefined) {
          if (this.boundVaultId) throw new Error("USE_NEW_LOCAL_VAULT");
          const name = createName.normalize("NFKC").trim();
          if (!name || [...name].length > 80) throw new Error("VAULT_NAME_INVALID");
          if (password.length < 8) throw new Error("VAULT_PASSWORD_TOO_SHORT");
          const manifestPath = `${this.root}/managed-create.json`, adapter = this.app.vault.adapter;
          const schema = z.strictObject({ endpoint: z.string(), userId: z.string(), id: z.string(), name: z.string(), epoch: z.string(), keyPackage: z.unknown() });
          const pending = await adapter.exists(manifestPath) ? schema.parse(JSON.parse(await adapter.read(manifestPath))) : null;
          let draft: z.infer<typeof schema>;
          if (pending && pending.endpoint === this.endpoint && pending.userId === connection.user.id && pending.name === name) draft = pending;
          else {
            const id = randomId(), created = await VaultCrypto.create(id, password); created.crypto.close();
            draft = { endpoint: this.endpoint, userId: connection.user.id, id, name, epoch: randomId(), keyPackage: created.keyPackage };
            const encoded = JSON.stringify(draft); await adapter.write(manifestPath, encoded);
            if (await adapter.read(manifestPath) !== encoded) throw new Error("CREATION_WRITE_INCOMPLETE");
          }
          material = await this.unlockManagedMaterial(draft.id, draft.keyPackage, password);
          // Protect the decryption material before publishing the immutable creation request.
          stage?.("storage");
          material = await this.prepareManagedMaterial(this.endpoint, material, connection.user.keyRevision);
          stage?.("server");
          vault = await client.create({ id: draft.id, name, epoch: draft.epoch, keyPackage: draft.keyPackage });
        } else {
          const selected = connection.vaults.find(vault => vault.id === vaultId);
          if (!selected) throw new Error("VAULT_NOT_FOUND");
          vault = selected;
          material = await this.unlockManagedMaterial(vault.id, vault.keyPackage, password);
        }
        await this.installManaged(client, vault, material, this.deviceName, this.endpoint, this.accessRecord!, connection.user.id, connection.user.keyRevision, stage);
        this.accessibleVaults = (await client.connection()).vaults;
      } finally { this.configuring = false; this.updateAutomation(); this.emit(); }
    });
  }
  private async unlockManagedMaterial(vaultId: string, keyPackage: unknown, password: string): Promise<StoredMaterial> {
    const keys = await VaultCrypto.unlock(vaultId, keyPackage, password);
    try {
      return { format: 0, vaultId, keyPackageFingerprint: await fingerprint(new TextEncoder().encode(canonical(keyPackage))), session: keys.sessionMaterial() };
    } finally { keys.close(); }
  }
  private async prepareManagedMaterial(endpoint: string, material: StoredMaterial, accessRevision: number): Promise<StoredMaterial & { token: string }> {
    const pendingStore = this.unlockStore(endpoint, `pending-${await fingerprint(new TextEncoder().encode(`managed:${endpoint}:${material.vaultId}`))}.json`, material.vaultId);
    const pending = await pendingStore.load();
    if (pending && pending.keyPackageFingerprint !== material.keyPackageFingerprint) throw new Error("KEY_PACKAGE_CHANGED");
    const token = (pending?.accessRevision === accessRevision ? pending.token : undefined) ?? (material.accessRevision === accessRevision ? material.token : undefined) ?? randomId();
    // Persist the exact token before publishing a vault or enrolling a device, so either operation can retry.
    const prepared = { ...material, token, accessRevision };
    await pendingStore.save(prepared);
    return prepared;
  }
  private async installManaged(client: AccessClient, vault: ManagedVault, material: StoredMaterial, name: string, endpoint: string, accessRecord: string, userId: string, accessRevision: number, stage?: (step: ConnectionStep) => void): Promise<void> {
    if (!this.config || !this.db || !this.port) throw new Error("LOCAL_IDENTITY_NOT_READY");
    const progress = await this.db.progress.get("progress");
    if (progress && (progress.vaultId !== vault.id || progress.epoch !== vault.epoch)) throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
    stage?.("storage");
    const { token } = await this.prepareManagedMaterial(endpoint, material, accessRevision);
    if (this.disposed) throw new Error("PLUGIN_UNLOADED");
    stage?.("authorization");
    await client.enroll(vault.id, { deviceId: this.config.deviceId, name, tokenHash: await fingerprint(new TextEncoder().encode(token)) });
    const remote = new Transport(endpoint, token, obsidianHTTP, undefined, vault.id);
    const candidate = new SyncEngine(this.db, remote, this.port, this.config.deviceId, vault.id, this.policy);
    let installed = false;
    try {
      await candidate.restoreRemembered(material); await candidate.validateConnection();
      const own = (await remote.devices()).find(device => device.id === this.config!.deviceId);
      if (!own) throw new Error("HANDSHAKE_MISMATCH");
      stage?.("name");
      const profile = await remote.putProfile({ name, expectedRevision: own.revision, ciphertext: candidate.sealProfile(own.revision + 1, this.configuration(name)) });
      stage?.("storage");
      const record = `connection-${randomId()}.json`, remembered = this.unlockStore(endpoint, record, vault.id), previous = this.remembered;
      await remembered.save({ ...candidate.rememberedMaterial(), token, accessRevision });
      await previous?.prepareRetirement();
      const oldAccess = this.accessRecord && this.accessRecord !== accessRecord ? this.accessStore() : undefined;
      await oldAccess?.prepareRetirement();
      if (this.disposed) throw new Error("PLUGIN_UNLOADED");
      await this.saveData({ format: 4, language: this.i18n.preference, vaultId: vault.id, vaultName: vault.name, accessRecord, userId, autoSync: this.autoSync, endpoint, record, restoreAllowed: true, clientName: name, rules: this.rules, profileRevision: profile.revision, profileDirty: false });
      if (this.disposed) throw new Error("PLUGIN_UNLOADED");
      this.engine?.lock(); this.engine = candidate; installed = true; this.config.vaultId = vault.id; this.config.token = token;
      this.remote = remote; this.endpoint = endpoint; this.deviceName = name; this.connectionRecord = record; this.remembered = remembered;
      this.accessRecord = accessRecord; this.accessUserId = userId; this.vaultName = vault.name; this.restoreAllowed = true; this.hasSavedKey = true; this.accessSaved = true;
      this.profileRevision = profile.revision; this.profileDirty = false; this.profilePending = undefined;
      try { await previous?.retire(remembered); await oldAccess?.retire(this.accessStore()); } catch { /* Installed pointers remain authoritative; retirement can retry. */ }
      await this.cleanupConnectionRecords(); this.connectEvents(remote);
    } finally { if (!installed) candidate.lock(); }
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
          const previousRecord = this.remembered;
          await previousRecord?.prepareRetirement();
          if (this.disposed) throw new Error("PLUGIN_UNLOADED");
          // Immutable protected records keep the previous configuration usable if saving the pointer fails.
          await this.saveData({ format: 4, language: this.i18n.preference, vaultId, autoSync: this.autoSync, endpoint, record, restoreAllowed: true, clientName: name, rules: this.rules, profileRevision: receipt.revision, profileDirty: false });
          if (this.disposed) throw new Error("PLUGIN_UNLOADED");
          this.engine?.lock(); this.engine = candidate; installed = true; this.config.vaultId = vaultId; this.config.token = token;
          this.endpoint = endpoint; this.remote = remote; this.deviceName = name; this.profileRevision = receipt.revision; this.profileDirty = false; this.profilePending = undefined; this.connectionRecord = record; this.restoreAllowed = true; this.remembered = remembered;
          this.hasSavedKey = true;
          try { await previousRecord?.retire(remembered); } catch { /* The previous pointer is no longer active; a later cleanup can retry. */ }
          await this.cleanupConnectionRecords();
          this.hostError = ""; this.connectEvents(remote);
          observe?.({ step: "storage", state: "passed" });
        } finally {
          if (!installed) candidate?.lock();
          this.configuring = false; this.updateAutomation();
          if (!this.disposed && this.engine) this.publishStatus(await this.engine.status(), false);
        }
      });
    } catch (error) {
      const failed = connectionFailure(error, step, this.i18n.t);
      if (failed.step === "authorization") observe?.({ step: "server", state: "passed" });
      observe?.({ step: failed.step, state: "failed", message: failed.message });
      throw error;
    }
  }
  async sync(notify = true, full = true): Promise<void> {
    const t = this.i18n.t;
    await this.work.run(async () => {
      if (!this.engine || this.disposed || !this.autoSync || this.configuring) return;
      const generation = this.changeGeneration;
      this.syncing = true;
      // A new run starts by checking, never by replaying the previous run's activity.
      if (this.lastStatus) this.lastStatus = { ...this.lastStatus, activity: undefined };
      this.showPending();
      let finished = false, refreshing = false;
      this.statusTimer = timerHost().setInterval(() => {
        if (refreshing || finished || this.disposed) return;
        refreshing = true;
        void this.engine!.status().then(status => {
          if (!finished && !this.disposed) this.publishStatus(status, false);
        }).catch(() => { /* The running sync reports persistence failures. */ }).finally(() => { refreshing = false; });
      }, 500);
      try {
        let profileError = "";
        try { await this.flushProfile(); } catch (error) { profileError = t("客户端配置快照未更新：{0}", String(error)); }
        const status = full ? await this.engine.sync() : await this.engine.sync({ full: false });
        if (full && !status.errors.length) this.lastFullCheck = Date.now();
        finished = true; this.syncing = false;
        this.localPending = this.changeGeneration !== generation;
        this.hostError = profileError; this.publishStatus(status, notify);
      } catch (error) {
        this.hostError = String(error);
        this.lastStatus = { outbox: 0, inbox: 0, conflicts: 0, ...this.lastStatus,
          state: this.engine.unlocked ? "needs-attention" : "locked", activity: undefined,
          errors: [...(this.lastStatus?.errors ?? []), this.hostError] };
        if (notify) new Notice(t("同步暂停：{0}", String(error)));
      }
      finally {
        finished = true; timerHost().clearInterval(this.statusTimer); this.statusTimer = undefined; this.syncing = false;
        if (!this.disposed) { this.renderStatusBar(); this.emit(); }
      }
    });
  }
  get syncStatus(): ReturnType<typeof syncPresentation> {
    return syncPresentation(this.lastStatus, !!this.engine?.unlocked, this.autoSync, this.syncing, this.localPending, this.i18n.t);
  }
  private renderStatusBar(): string {
    const display = this.syncStatus;
    this.statusEl?.setText(`xSync · ${display.label}`);
    if (this.statusEl) this.statusEl.dataset.state = display.state;
    if (this.ribbonEl) {
      this.ribbonEl.dataset.state = display.state;
      const count = this.lastStatus?.conflicts ?? 0;
      this.ribbonEl.dataset.count = count > 99 ? "99+" : String(count);
      this.ribbonEl.setAttribute("aria-label", `xSync · ${display.label}`);
    }
    return display.label;
  }
  private publishStatus(status: EngineStatus, notify: boolean): void {
    const t = this.i18n.t;
    this.lastStatus = status;
    const label = this.renderStatusBar();
    if (notify && status.state === "needs-attention" && !status.conflicts) new Notice(t("{0}，本机内容仍保留。", label));
    this.emit();
  }
  async resolveConflict(review: Review, selectedRevision: string, companionPath?: string, mergedBytes?: Uint8Array): Promise<void> {
    const t = this.i18n.t;
    await this.work.run(async () => {
      if (!this.engine || this.disposed) throw new Error("LOCAL_IDENTITY_NOT_READY");
      if (!this.autoSync || this.configuring) throw new Error(t("请先恢复同步"));
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
    const t = this.i18n.t;
    if (!this.remote || !this.engine?.unlocked) throw new Error(t("请先保存连接配置"));
    const rows = await this.remote.devices();
    const own = rows.find(row => row.id === this.config?.deviceId); if (own && !this.configuring) this.deviceName = own.name;
    this.clients = rows.map(row => {
      try { return { ...row, configuration: row.ciphertext ? decodeProfile(this.engine!.openProfile(row.id, row.revision, row.ciphertext), row.name) : undefined }; }
      catch { return { id: row.id, name: row.name, revision: row.revision, reportedAt: row.reportedAt, revoked: row.revoked, error: t("此配置快照无法验证，原数据保留") }; }
    });
    return this.clients;
  }
  private async flushProfile(): Promise<void> {
    const t = this.i18n.t;
    if (!this.remote || !this.engine?.unlocked || !this.config) return;
    const rows = await this.refreshClients(); const own = rows.find(r => r.id === this.config!.deviceId);
    if (!own) throw new Error("DEVICE_PROFILE_MISSING");
    if (this.profileRevision === undefined) { this.profileRevision = own.revision; this.deviceName = own.name; }
    if (own.configuration && (own.configuration.pluginVersion !== buildManifest.version || own.configuration.platform !== this.configuration().platform)) this.profileDirty = true;
    if (!this.profileDirty && !this.profilePending) return;
    if (!this.profilePending) {
      if (own.revision !== this.profileRevision) throw new Error(t("PROFILE_STALE: 请重新保存本机规则"));
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
    const t = this.i18n.t;
    const rules = validateRules(input); const policy = new SyncPolicy(rules);
    await this.work.run(async () => {
      const prior = this.rules; this.rules = rules; this.profileDirty = true;
      try { await this.saveSettings(); } catch (error) { this.rules = prior; throw error; }
      this.policy = policy; this.engine?.setPolicy(policy); this.configStamp = new Map(); this.emit();
    });
    this.automatic?.trigger("rules", true);
    void this.work.run(async () => { try { await this.flushProfile(); } catch (error) { this.hostError = t("配置已在本机保存，快照待上报：{0}", String(error)); this.emit(); } });
  }
  async inventory(): Promise<FileEntry[]> { if (!this.port) return []; return this.port.inventory(); }
  async excludedChildren(path: string): Promise<FileEntry[]> { return this.port?.excludedChildren(path) ?? []; }
  get configurationReloadNeeded(): boolean { return this.port?.configurationChanged ?? false; }
  private async pollConfiguration(): Promise<void> {
    const t = this.i18n.t;
    if (this.configScanning || this.disposed || !this.autoSync || !this.port) return;
    this.configScanning = true;
    try {
      const stats = await this.port.configurationStats();
      const changed = [...new Set([...stats.keys(), ...this.configStamp.keys()])].filter(path => stats.get(path) !== this.configStamp.get(path));
      for (const path of changed) await this.db!.markDirty(path);
      this.configStamp = stats;
      if (changed.length) this.automatic?.trigger("file");
    }
    catch (error) { this.hostError = t("配置扫描失败：{0}", String(error)); this.emit(); }
    finally { this.configScanning = false; }
  }
  private addUiCommand(command: Command): void {
    const name = this.i18n.t(command.name), registered = this.addCommand({ ...command, name });
    this.localizedCommands.push({ source: command.name, prefix: registered.name.slice(0, -name.length), command: registered });
  }
  private updateCommandLanguage(): void {
    for (const entry of this.localizedCommands) entry.command.name = entry.prefix + this.i18n.t(entry.source);
  }
  async setLanguage(language: LanguagePreference): Promise<void> {
    await this.work.run(async () => {
      const saved: unknown = await this.loadData();
      if (saved !== null && saved !== undefined && (typeof saved !== "object" || Array.isArray(saved))) throw new Error("INVALID_CONNECTION_SETTINGS");
      await this.saveData({ ...(saved ?? {}), language });
      this.i18n.preference = language;
      this.updateCommandLanguage(); this.renderStatusBar(); this.emit();
    });
  }
  async saveSettings(): Promise<void> {
    await this.saveData({ format: 4, language: this.i18n.preference, vaultId: this.config?.vaultId ?? "", autoSync: this.autoSync, endpoint: this.endpoint, record: this.connectionRecord, restoreAllowed: this.restoreAllowed, clientName: this.deviceName, rules: this.rules, profileRevision: this.profileRevision ?? 0, profileDirty: this.profileDirty, ...(this.accessRecord ? { accessRecord: this.accessRecord, userId: this.accessUserId, vaultName: this.vaultName } : {}), ...(this.profilePending ? { profilePending: this.profilePending } : {}) });
  }

}
class ConnectionModal extends Modal {
  private cleanup?: () => void;
  constructor(app: App, private plugin: ObsidianSyncPlugin) { super(app); }
  onOpen(): void { this.modalEl.addClass("oss-connection-modal"); this.cleanup = connectionForm(this.contentEl.createDiv(), this.plugin); }
  onClose(): void { this.cleanup?.(); this.cleanup = undefined; this.contentEl.empty(); }
}
