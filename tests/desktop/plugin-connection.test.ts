import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestUrl, type App, type PluginManifest } from "obsidian";
import { SYNC_FEATURES } from "../../protocol/src/wire";
import type { ConnectionCheck } from "../../plugin/src/sync/connection-check";
import { VaultCrypto, randomId } from "../../plugin/src/sync/crypto";
import { SyncDB } from "../../plugin/src/sync/store";
import { AutomaticSync, RemoteEvents } from "../../plugin/src/sync/realtime";
import { RememberedUnlock } from "../../plugin/src/desktop/remembered-unlock";
import { RecoveryFixture, recoveryHTTP, RECOVERY_PASSPHRASE } from "./recovery-support";
import { Transport } from "../../plugin/src/sync/transport";

const host = vi.hoisted(() => ({ saved: null as unknown, failSave: false, failProtect: false, failUnprotect: false, loseEnrollment: false, enrollments: [] as unknown[], modern: false, onboarding: {} as unknown, reads: 0, status: 200, files: new Map<string, string>(), handshake: {} as unknown, profile: { id: "device", name: "Fixture", revision: 0, ciphertext: "" }, handlers: new Map<string, (...args: unknown[]) => void>() }));
vi.mock("obsidian", () => ({
  Plugin: class {
    constructor(public app: unknown, public manifest: unknown) {}
    addStatusBarItem() { return { setText() {}, addClass() {}, setAttribute() {}, dataset: {} }; } addRibbonIcon() { return { addClass() {}, setAttribute() {}, dataset: {} }; } addCommand() {} addSettingTab() {} registerEvent() {}
    registerDomEvent(_target: unknown, name: string, callback: () => void) { host.handlers.set(name, callback); }
    async loadData() { return host.saved; }
    async saveData(value: unknown) { if (host.failSave) throw new Error("SETTINGS_WRITE_FAILED"); host.saved = structuredClone(value); }
  },
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {}, Platform: { isDesktop: true },
  requestUrl: vi.fn(async (request: { url: string; body?: ArrayBuffer }) => {
    let response = host.handshake;
    if (host.modern && request.url.endsWith("/onboarding")) response = host.onboarding;
    if (host.modern && request.url.endsWith("/enroll/challenges")) response = { id: "c".repeat(64), nonce: "d".repeat(64) };
    if (host.modern && request.url.endsWith("/enroll")) {
      const body = JSON.parse(new TextDecoder().decode(request.body)); host.enrollments.push(body);
      host.profile = { ...host.profile, id: body.deviceId, name: body.name };
      host.handshake = { ...(host.handshake as object), devices: [{ id: body.deviceId, name: body.name }] }; response = { enrolled: true };
      if (host.loseEnrollment) { host.loseEnrollment = false; throw new Error("RECEIPT_LOST"); }
    }
    if (request.url.endsWith("/devices")) response = { devices: [host.profile] };
    if (request.url.endsWith("/device/profile")) { const body = JSON.parse(new TextDecoder().decode(request.body)); if (body.expectedRevision !== host.profile.revision) throw new Error("PROFILE_STALE"); host.profile = { id: host.profile.id, name: body.name, revision: body.expectedRevision + 1, ciphertext: body.ciphertext }; response = host.profile; }
    return { status: host.status, headers: {}, arrayBuffer: new TextEncoder().encode(JSON.stringify(host.status === 200 ? response : { code: "UNAUTHORIZED" })).buffer };
  }),
}));
// The separate remembered-unlock tests exercise actual encryption and corruption. This fixture isolates host commit boundaries.
vi.mock("../../plugin/src/desktop/protector", () => ({ desktopProtector: () => ({ name: "host-test-only", protect: async (text: string) => { if (host.failProtect) throw new Error("OS_STORE_FAILED"); return new TextEncoder().encode(text); }, unprotect: async (bytes: Uint8Array) => { host.reads++; if (host.failUnprotect) throw new Error("PROTECTED_STORE_TEMPORARILY_UNAVAILABLE"); return new TextDecoder().decode(bytes); } }) }));
import ObsidianSyncPlugin from "../../plugin/src/sync-main";
let instance: ObsidianSyncPlugin | undefined;
let databaseId: string;
let keyPackage: unknown;
const endpoint = "http://127.0.0.1:8873";
beforeEach(async () => {
  host.profile = { id: "device", name: "Fixture", revision: 0, ciphertext: "" }; host.saved = null; host.failSave = false; host.failProtect = false; host.failUnprotect = false; host.modern = false; host.loseEnrollment = false; host.enrollments = []; host.reads = 0; host.status = 200; host.files.clear(); host.handlers.clear(); databaseId = randomId(); vi.mocked(requestUrl).mockClear();
  vi.stubGlobal("window", {}); vi.stubGlobal("document", {});
  const created = await VaultCrypto.create("host-test-vault", "test-sync-key"); keyPackage = created.keyPackage;
  host.onboarding = { format: 1, vaultId: "host-test-vault", epoch: "epoch", keyPackage, publicKey: created.crypto.enrollmentPublicKey() }; created.crypto.close();
  host.handshake = { protocol: 0, vaultId: "host-test-vault", epoch: "epoch", seq: 0, features: [...SYNC_FEATURES], continuity: true, keyPackage, devices: [{ id: "device", name: "Fixture" }], maxObjectBytes: 8388608 };
  host.files.set(".obsidian/obsidian-sync-development.json", JSON.stringify({ generatedBy: "ObsidianSync desktop test setup" }));
  host.files.set(".obsidian/obsidian-sync-local/device.json", JSON.stringify({ endpoint, token: "x".repeat(64), vaultId: "host-test-vault", deviceId: "device", deviceName: "Fixture", databaseId }));
});
afterEach(async () => { instance?.onunload(); instance = undefined; await new SyncDB(`obsidian-sync-dev-${databaseId}`).delete(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function load() {
  const adapter = { list: async (root: string) => ({ files: [...host.files.keys()].filter(p => p.startsWith(root+"/") && !p.slice(root.length+1).includes("/")), folders: [] }), remove: async (p: string) => { host.files.delete(p); }, mkdir: async (p: string) => { host.files.set(p, ""); }, exists: async (p: string) => host.files.has(p), read: async (p: string) => host.files.get(p)!, write: async (p: string, s: string) => { host.files.set(p, s); } };
  const app = { vault: { configDir: ".obsidian", adapter, on: (name: string, callback: (...args: unknown[]) => void) => { host.handlers.set(name, callback); } }, workspace: { getLeavesOfType: () => [], onLayoutReady(callback: () => void) { host.handlers.set("layout", callback); } } } as unknown as App;
  instance = new ObsidianSyncPlugin(app, { version: "0.1.0" } as PluginManifest); await instance.onload();
  databaseId = JSON.parse(host.files.get(".obsidian/obsidian-sync-local/device.json")!).databaseId;
  return instance;
}
function ordinaryVault() { host.modern = true; host.files.delete(".obsidian/obsidian-sync-development.json"); host.files.delete(".obsidian/obsidian-sync-local/device.json"); }
it.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1").each(["receipt", "pointer"])("preserves a rotated authorization after losing its %s, restarting and closing enrollment", async boundary => {
  const fixture = new RecoveryFixture(); await fixture.open(true);
  const originalRequest = vi.mocked(requestUrl).getMockImplementation()!;
  let loseReceipt = false;
  try {
    vi.mocked(requestUrl).mockImplementation(request => {
      const result = (async () => {
        const input = typeof request === "string" ? { url: request } : request;
        let body: Uint8Array | undefined;
        if (typeof input.body === "string") body = new TextEncoder().encode(input.body);
        else if (input.body) body = new Uint8Array(input.body);
        const response = await recoveryHTTP({ url: input.url, method: input.method ?? "GET", headers: input.headers ?? {}, body });
        if (loseReceipt && new URL(input.url).pathname === "/enroll" && response.status === 200) {
          loseReceipt = false; throw new Error("ENROLLMENT_RECEIPT_LOST");
        }
        const text = new TextDecoder().decode(response.bytes);
        return { status: response.status, headers: response.headers, arrayBuffer: response.bytes.slice().buffer, text, json: JSON.parse(text) };
      })();
      return Object.defineProperties(result, {
        arrayBuffer: { get: () => result.then(response => response.arrayBuffer) },
        text: { get: () => result.then(response => response.text) },
        json: { get: () => result.then(response => response.json) },
      }) as ReturnType<typeof requestUrl>;
    });
    ordinaryVault(); const plugin = await load();
    await plugin.saveConnection(fixture.endpoint, RECOVERY_PASSPHRASE, undefined, "Fixture");
    const oldRecord = (host.saved as { record: string }).record;
    const store = (owner: ObsidianSyncPlugin, name: string): RememberedUnlock =>
      (owner as unknown as { unlockStore(endpoint: string, record: string): RememberedUnlock }).unlockStore(fixture.endpoint, name);
    const old = (await store(plugin, oldRecord).load())!;
    await fixture.sql(`UPDATE ${fixture.schema}.vaults SET enrollment_until=clock_timestamp()+interval '10 minutes'`);
    plugin.engine!.lock();
    vi.spyOn(RememberedUnlock.prototype, "load").mockRejectedValueOnce(new Error("TEMPORARY_KEYCHAIN_READ_FAILURE"));
    host.failSave = boundary === "pointer"; loseReceipt = boundary === "receipt";
    await expect(plugin.saveConnection(fixture.endpoint, RECOVERY_PASSPHRASE, undefined, "Fixture"))
      .rejects.toThrow(boundary === "pointer" ? "SETTINGS_WRITE_FAILED" : "ENROLLMENT_RECEIPT_LOST");
    const root = ".obsidian/obsidian-sync-local/";
    const pending = [...host.files.keys()].find(path => /^pending-[a-f0-9]{64}\.json$/.test(path.slice(root.length)))!;
    expect(pending).toBeDefined();
    const fresh = (await store(plugin, pending.slice(root.length)).load())!;
    expect(fresh.token).not.toBe(old.token);
    await new Transport(fixture.endpoint, fresh.token!, recoveryHTTP).handshake();
    await expect(new Transport(fixture.endpoint, old.token!, recoveryHTTP).handshake()).rejects.toThrow("UNAUTHORIZED");
    const recoveryRecords = [...host.files.keys()].filter(path => path.startsWith(root) && path !== root + oldRecord && /(?:pending|connection)-[a-f0-9]{64}\.json$/.test(path));
    host.failSave = false; plugin.onunload(); await Promise.resolve();
    const restarted = await load();
    await (restarted as unknown as { startup(): Promise<void> }).startup();
    expect(restarted.engine!.unlocked).toBe(true);
    for (const path of recoveryRecords) expect(host.files.has(path)).toBe(true);
    await fixture.sql(`UPDATE ${fixture.schema}.vaults SET enrollment_until=clock_timestamp()-interval '1 second'`);
    await restarted.saveConnection(fixture.endpoint, "", undefined, "Fixture");
    await restarted.engine!.validateConnection();
    const current = (host.saved as { record: string }).record;
    expect((await store(restarted, current).load())!.token).toBe(fresh.token);
    expect(host.files.has(pending)).toBe(false); expect(host.files.has(root + oldRecord)).toBe(false);
    for (const path of recoveryRecords) expect(host.files.has(path)).toBe(false);
  } finally { vi.mocked(requestUrl).mockImplementation(originalRequest); await fixture.close(); }
}, 30000);

it("retires unreferenced protected records only after the new settings pointer succeeds", async () => {
  const plugin=await load(); await plugin.saveConnection(endpoint,"test-sync-key");
  const old=(host.saved as {record:string}).record, root=".obsidian/obsidian-sync-local/";
  host.files.set(root+"unrelated.json","keep"); host.failSave=true;
  await expect(plugin.saveConnection(endpoint,"")).rejects.toThrow("SETTINGS_WRITE_FAILED");
  expect(host.files.has(root+old)).toBe(true); expect((host.saved as {record:string}).record).toBe(old);
  expect([...host.files.keys()].filter(path=>path.startsWith(root+"connection-") && path.endsWith(".json")).length).toBe(2);
  host.failSave=false; await plugin.saveConnection(endpoint,"");
  const current=(host.saved as {record:string}).record;
  expect([...host.files.keys()].filter(path=>path.startsWith(root+"connection-"))).toEqual([root+current]);
  expect(host.files.get(root+"unrelated.json")).toBe("keep");
  expect(await (plugin as unknown as {remembered:RememberedUnlock}).remembered.load()).not.toBeNull();
});
it.each(["address", "token"])("journals the previous %s credential before publishing a new pointer and recovers after unload", async kind => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key");
  const root = ".obsidian/obsidian-sync-local/", old = (host.saved as { record: string }).record;
  const oldEnvelope = host.files.get(root + old)!;
  const nextEndpoint = kind === "address" ? "http://localhost:8873" : endpoint;
  if (kind === "token") (plugin as unknown as { config: { token: string } }).config.token = "n".repeat(64);
  const save = plugin.saveData.bind(plugin);
  vi.spyOn(plugin, "saveData").mockImplementation(async value => {
    expect(JSON.parse(host.files.get(root + old + ".retiring")!)).toMatchObject({ identity: { endpoint }, record: oldEnvelope });
    await save(value); plugin.onunload();
  });
  await expect(plugin.saveConnection(nextEndpoint, "")).rejects.toThrow("PLUGIN_UNLOADED");
  expect(host.files.has(root + old)).toBe(true);
  const current = (host.saved as { record: string }).record;
  expect(current).not.toBe(old);
  const restarted = await load(); await (restarted as unknown as { startup(): Promise<void> }).startup();
  expect(restarted.engine!.unlocked).toBe(true);
  expect(host.files.has(root + old)).toBe(false); expect(host.files.has(root + old + ".retiring")).toBe(false);
  expect(host.files.has(root + current)).toBe(true);
});
it("keeps the active credential and its prepared journal when publishing the new pointer fails", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key");
  const saved = structuredClone(host.saved), root = ".obsidian/obsidian-sync-local/", old = (host.saved as { record: string }).record;
  const original = host.files.get(root + old);
  host.failSave = true;
  await expect(plugin.saveConnection("http://localhost:8873", "")).rejects.toThrow("SETTINGS_WRITE_FAILED");
  expect(host.saved).toEqual(saved); expect(host.files.has(root + old + ".retiring")).toBe(true);
  plugin.onunload(); await Promise.resolve(); host.failSave = false;
  const restarted = await load(); await (restarted as unknown as { startup(): Promise<void> }).startup();
  expect(restarted.engine!.unlocked).toBe(true); expect(host.files.get(root + old)).toBe(original);
  expect(host.files.has(root + old + ".retiring")).toBe(true);
  await restarted.saveConnection("http://localhost:8873", "");
  expect(host.files.has(root + old)).toBe(false); expect(host.files.has(root + old + ".retiring")).toBe(false);
});
it.each(["before-write", "after-write", "unload"])("does not publish a new pointer when retirement preparation stops at %s", async boundary => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key");
  const saved = structuredClone(host.saved), root = ".obsidian/obsidian-sync-local/", old = (host.saved as { record: string }).record;
  const original = host.files.get(root + old), prepare = RememberedUnlock.prototype.prepareRetirement;
  vi.spyOn(RememberedUnlock.prototype, "prepareRetirement").mockImplementationOnce(async function(this: RememberedUnlock) {
    if (boundary !== "before-write") await prepare.call(this);
    if (boundary === "unload") plugin.onunload(); else throw new Error("RETIREMENT_PREPARE_INTERRUPTED");
  });
  const save = vi.spyOn(plugin, "saveData");
  await expect(plugin.saveConnection("http://localhost:8873", "")).rejects.toThrow(boundary === "unload" ? "PLUGIN_UNLOADED" : "RETIREMENT_PREPARE_INTERRUPTED");
  expect(save).not.toHaveBeenCalled(); expect(host.saved).toEqual(saved);
  expect(host.files.get(root + old)).toBe(original);
  expect(host.files.has(root + old + ".retiring")).toBe(boundary !== "before-write");
});
it("can replace a damaged old envelope while retaining it as uncertain recovery evidence", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key");
  const root = ".obsidian/obsidian-sync-local/", old = (host.saved as { record: string }).record;
  host.files.set(root + old, "{damaged envelope");
  await plugin.saveConnection("http://localhost:8873", "");
  expect((host.saved as { record: string }).record).not.toBe(old);
  expect(plugin.engine!.unlocked).toBe(true); expect(host.files.get(root + old)).toBe("{damaged envelope");
  expect(JSON.parse(host.files.get(root + old + ".retiring")!).record).toBe("{damaged envelope");
});
it("initializes an ordinary vault without a marker, and reloads its protected credential with the same identity and pause state", async () => {
  ordinaryVault(); const plugin = await load(); const identity = host.files.get(".obsidian/obsidian-sync-local/device.json")!;
  expect(Object.keys(JSON.parse(identity)).sort()).toEqual(["databaseId","deviceId"]); expect(plugin.engine).toBeUndefined(); expect(plugin.endpoint).toBe("");
  await plugin.saveConnection(endpoint,"test-sync-key",undefined,"我的电脑"); await plugin.setAutoSync(false);
  expect(host.enrollments).toHaveLength(1); expect(host.saved).toMatchObject({format:4,vaultId:"host-test-vault",autoSync:false});
  expect(host.files.get(".obsidian/obsidian-sync-local/device.json")).toBe(identity);
  expect(JSON.stringify(host.saved)).not.toContain("token"); expect(identity).not.toContain("token");
  plugin.onunload(); await Promise.resolve(); const reloaded = await load();
  await (reloaded as unknown as {startup():Promise<void>}).startup(); expect(reloaded.engine?.unlocked).toBe(true); expect(reloaded.autoSync).toBe(false);
  await reloaded.saveConnection(endpoint,"",undefined,"我的电脑"); expect(host.enrollments).toHaveLength(1);
});
it.each(["receipt","pointer"])("recovers an ordinary first connection after losing the %s without changing identity or token",async boundary => {
  ordinaryVault(); const plugin = await load(); const identity = host.files.get(".obsidian/obsidian-sync-local/device.json");
  if (boundary === "receipt") host.loseEnrollment = true; else host.failSave = true;
  await expect(plugin.saveConnection(endpoint,"test-sync-key",undefined,"手机")).rejects.toThrow(); expect(host.saved).toBeNull(); expect(plugin.engine).toBeUndefined();
  const draft = host.enrollments[0]; plugin.onunload(); await Promise.resolve(); host.failSave = false;
  const reloaded = await load(); await reloaded.saveConnection(endpoint,"test-sync-key",undefined,"手机的新名称");
  expect(host.enrollments).toHaveLength(2); expect(host.enrollments[1]).toEqual(draft); expect(reloaded.engine?.unlocked).toBe(true); expect(reloaded.deviceName).toBe("手机的新名称");
  expect(host.files.get(".obsidian/obsidian-sync-local/device.json")).toBe(identity);
});
it("refuses to authorize an ordinary device before safe local persistence succeeds",async () => {
  ordinaryVault(); const plugin = await load(); host.failProtect = true;
  await expect(plugin.saveConnection(endpoint,"test-sync-key",undefined,"手机")).rejects.toThrow("OS_STORE_FAILED");
  expect(host.enrollments).toHaveLength(0); expect(host.saved).toBeNull(); expect(plugin.engine).toBeUndefined();
});
it("does not start enrollment after unloading while the pending credential is being persisted",async () => {
  ordinaryVault(); const plugin = await load(); const save = RememberedUnlock.prototype.save;
  vi.spyOn(RememberedUnlock.prototype,"save").mockImplementationOnce(async function(this: RememberedUnlock, material) { await save.call(this,material); plugin.onunload(); });
  await expect(plugin.saveConnection(endpoint,"test-sync-key",undefined,"手机")).rejects.toThrow("PLUGIN_UNLOADED");
  expect(host.enrollments).toHaveLength(0); expect(host.saved).toBeNull(); expect(plugin.engine).toBeUndefined();
});
it("does not silently create a new identity when a configured ordinary vault loses its identity file",async () => {
  ordinaryVault(); const plugin = await load(); await plugin.saveConnection(endpoint,"test-sync-key",undefined,"手机");
  plugin.onunload(); await Promise.resolve(); host.files.delete(".obsidian/obsidian-sync-local/device.json");
  const saved = structuredClone(host.saved);
  const adapter = {exists:async(p:string)=>host.files.has(p),read:async(p:string)=>host.files.get(p)!,mkdir:async()=>{},write:async(p:string,v:string)=>{host.files.set(p,v);}};
  const reloaded = new ObsidianSyncPlugin({vault:{configDir:".obsidian",adapter}} as unknown as App,{version:"0.1.0"} as PluginManifest);
  instance = reloaded; await reloaded.onload();
  expect(reloaded.engine).toBeUndefined(); expect(host.files.has(".obsidian/obsidian-sync-local/device.json")).toBe(false); expect(host.saved).toEqual(saved);
});
it("saves an entered address with an immutable protected-key reference; pause and reload keep the key", async () => {
  const plugin = await load(); expect(plugin.hasSavedKey).toBe(false); await plugin.saveConnection(" http://localhost:8873/ ", "test-sync-key");
  expect(plugin.hasSavedKey).toBe(true);
  expect(plugin.endpoint).toBe("http://localhost:8873"); expect(plugin.engine?.unlocked).toBe(true);
  const saved = host.saved as { format: number; endpoint: string; record: string; autoSync: boolean };
  expect(saved).toMatchObject({ format: 4, endpoint: "http://localhost:8873", autoSync: true });
  expect(saved.record).toMatch(/^connection-[a-f0-9]{64}\.json$/); expect(JSON.stringify(saved)).not.toContain("test-sync-key");
  const encryptedRecord = host.files.get(`.obsidian/obsidian-sync-local/${saved.record}`);
  await plugin.setAutoSync(false); expect(host.saved).toMatchObject({ autoSync: false, record: saved.record });
  expect(host.files.get(`.obsidian/obsidian-sync-local/${saved.record}`)).toBe(encryptedRecord);
  plugin.onunload(); await Promise.resolve();
  const reloaded = await load();
  expect(reloaded.hasSavedKey).toBe(true); expect(reloaded.engine?.unlocked).toBe(false);
  // Startup is normally invoked by Obsidian's layout callback, deliberately held by this fixture.
  await (reloaded as unknown as { startup(): Promise<void> }).startup();
  expect(reloaded.autoSync).toBe(false); expect(reloaded.engine?.unlocked).toBe(true);
  await reloaded.setAutoSync(true); expect(reloaded.engine?.unlocked).toBe(true);
});
it.each([false, true])("retries transient protected-store failure on foreground while preserving autoSync=%s", async autoSync => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key"); await plugin.setAutoSync(autoSync);
  const saved = structuredClone(host.saved); const records = new Map(host.files); plugin.onunload(); await Promise.resolve();
  vi.spyOn(AutomaticSync.prototype, "start").mockImplementation(() => {}); vi.spyOn(RemoteEvents.prototype, "start").mockImplementation(() => {});
  host.failUnprotect = true; const reloaded = await load();
  const idle = () => (reloaded as unknown as { work: { idle(): Promise<void> } }).work.idle();
  host.handlers.get("layout")!(); await idle(); expect(reloaded.engine?.unlocked).toBe(false);
  expect(reloaded.hasSavedKey).toBe(true);
  expect(host.saved).toEqual(saved); expect(host.files).toEqual(records);
  host.failUnprotect = false; const reads = host.reads;
  host.handlers.get("focus")!(); host.handlers.get("online")!(); host.handlers.get("visibilitychange")!(); await idle();
  expect(reloaded.engine?.unlocked).toBe(true); expect(host.reads).toBe(reads + 1); expect(reloaded.autoSync).toBe(autoSync);
  if (autoSync) expect(AutomaticSync.prototype.start).toHaveBeenCalled(); else expect(AutomaticSync.prototype.start).not.toHaveBeenCalled();
  expect(host.saved).toEqual(saved); expect(host.files).toEqual(records);
});
it("does not retry protected reads or unlock after unload receives a late foreground event", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key"); plugin.onunload(); await Promise.resolve();
  host.failUnprotect = true; const reloaded = await load();
  host.handlers.get("layout")!(); await (reloaded as unknown as { work: { idle(): Promise<void> } }).work.idle();
  reloaded.onunload(); host.failUnprotect = false; const reads = host.reads; host.handlers.get("focus")!(); await Promise.resolve();
  expect(host.reads).toBe(reads); expect(reloaded.engine?.unlocked).toBe(false);
});
it("wrong key, wrong vault and settings-write failure preserve the previous server and exact saved record", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key"); const previous = structuredClone(host.saved); const engine = plugin.engine;
  await expect(plugin.saveConnection("http://localhost:8873", "wrong-key")).rejects.toThrow();
  expect(host.saved).toEqual(previous); expect(plugin.engine).toBe(engine); expect(engine?.unlocked).toBe(true);
  host.handshake = { ...(host.handshake as object), vaultId: "other-vault" };
  await expect(plugin.saveConnection("http://localhost:8873", "test-sync-key")).rejects.toThrow("HANDSHAKE_MISMATCH"); expect(host.saved).toEqual(previous);
  host.handshake = { ...(host.handshake as object), vaultId: "host-test-vault" }; host.failSave = true;
  await expect(plugin.saveConnection("http://localhost:8873", "test-sync-key")).rejects.toThrow("SETTINGS_WRITE_FAILED");
  expect(host.saved).toEqual(previous); expect(plugin.endpoint).toBe(endpoint); expect(plugin.engine).toBe(engine); expect(engine?.unlocked).toBe(true);
});
it("retains the known key-package anchor when editing the address", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key"); const previous = structuredClone(host.saved);
  const replacement = await VaultCrypto.create("host-test-vault", "another-key"); replacement.crypto.close();
  host.handshake = { ...(host.handshake as object), keyPackage: replacement.keyPackage };
  await expect(plugin.saveConnection("http://localhost:8873", "another-key")).rejects.toThrow("KEY_PACKAGE_CHANGED"); expect(host.saved).toEqual(previous);
});
it("does not install live keys if the plugin unloads while publishing the saved configuration", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key"); const previousEngine = plugin.engine;
  plugin.saveData = vi.fn(async value => { host.saved = value; plugin.onunload(); });
  await expect(plugin.saveConnection("http://localhost:8873", "test-sync-key")).rejects.toThrow("PLUGIN_UNLOADED");
  expect(plugin.engine).toBe(previousEngine); expect(plugin.engine?.unlocked).toBe(false);
  expect(host.saved).toMatchObject({ format: 4, endpoint: "http://localhost:8873" });
});
it("reuses the protected key for save-and-test and reads the remote handshake and saves only an encrypted device profile, retaining pause state", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key"); await plugin.setAutoSync(false);
  vi.mocked(requestUrl).mockClear(); const checks: ConnectionCheck[] = [];
  await plugin.saveConnection("http://localhost:8873", "", check => checks.push(check));
  expect(checks.filter(c => c.state === "passed").map(c => c.step)).toEqual(["server", "authorization", "key", "name", "storage"]);
  expect(plugin.engine?.unlocked).toBe(true); expect(plugin.autoSync).toBe(false); expect(host.saved).toMatchObject({ endpoint: "http://localhost:8873", autoSync: false });
  expect(vi.mocked(requestUrl).mock.calls.map(([r]) => typeof r === "string" ? r : r.method + " " + new URL(r.url).pathname)).toEqual(["GET /handshake", "GET /devices", "PUT /device/profile"]);
  const request = vi.mocked(requestUrl).mock.calls.at(-1)![0]; if (typeof request !== "string") { const body = new TextDecoder().decode(request.body as ArrayBuffer); expect(body).not.toContain("test-sync-key"); expect(body).not.toContain("maxMB"); }
});
it("reports reachable server with rejected authorization separately, keeping the previous configuration", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key"); const previous = structuredClone(host.saved);
  host.status = 401; const checks: ConnectionCheck[] = [];
  await expect(plugin.saveConnection(endpoint, "", check => checks.push(check))).rejects.toThrow("UNAUTHORIZED");
  expect(checks.some(c => c.step === "server" && c.state === "passed")).toBe(true);
  expect(checks.at(-1)).toMatchObject({ step: "authorization", state: "failed" });
  expect(checks.some(c => c.step === "storage")).toBe(false); expect(host.saved).toEqual(previous);
});
it("reports key failure after successful handshake and does not report safe saving", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key"); const previous = structuredClone(host.saved); const checks: ConnectionCheck[] = [];
  await expect(plugin.saveConnection(endpoint, "wrong-key", check => checks.push(check))).rejects.toThrow();
  expect(checks.filter(c => c.state === "passed").map(c => c.step)).toEqual(["server", "authorization"]);
  expect(checks.at(-1)).toMatchObject({ step: "key", state: "failed" }); expect(host.saved).toEqual(previous);
});
it("reports a missing first key without making any server request or saving configuration", async () => {
  const plugin = await load(); const checks: ConnectionCheck[] = [];
  await expect(plugin.saveConnection(endpoint, "", check => checks.push(check))).rejects.toThrow("CONNECTION_KEY_REQUIRED");
  expect(vi.mocked(requestUrl)).not.toHaveBeenCalled(); expect(host.saved).toBeNull(); expect(checks.at(-1)).toMatchObject({ step: "key", state: "failed" });
});
it("refuses a replacement master key against retained revisions even when no active session anchor is available", async () => {
  const plugin = await load(); await plugin.saveConnection(endpoint, "test-sync-key"); const saved = structuredClone(host.saved);
  const old = await VaultCrypto.unlock("host-test-vault", keyPackage, "test-sync-key");
  const base = { id: "retained-revision", fileId: "retained-file", parents: [], deviceId: "device" };
  await plugin.engine!.db.revisions.put({ ...base, payload: await old.payload(base, new TextEncoder().encode("retained"), "file", []) }); old.close(); plugin.engine!.lock();
  const replacement = await VaultCrypto.create("host-test-vault", "replacement-passphrase"); replacement.crypto.close(); host.handshake = { ...(host.handshake as object), keyPackage: replacement.keyPackage };
  await expect(plugin.saveConnection(endpoint, "replacement-passphrase")).rejects.toThrow("LOCAL_KEY_ANCHOR_MISMATCH");
  expect(host.saved).toEqual(saved); expect(await plugin.engine!.db.revisions.get("retained-revision")).toBeDefined();
});
