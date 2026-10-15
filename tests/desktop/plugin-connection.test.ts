import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestUrl, type App, type PluginManifest } from "obsidian";
import { SYNC_FEATURES } from "../../protocol/src/wire";
import type { ConnectionCheck } from "../../plugin/src/sync/connection-check";
import { VaultCrypto, randomId } from "../../plugin/src/sync/crypto";
import { SyncDB } from "../../plugin/src/sync/store";

const host = vi.hoisted(() => ({ saved: null as unknown, failSave: false, status: 200, files: new Map<string, string>(), handshake: {} as unknown, profile: { id: "device", name: "Fixture", revision: 0, ciphertext: "" }, handlers: new Map<string, (...args: unknown[]) => void>() }));
vi.mock("obsidian", () => ({
  Plugin: class {
    constructor(public app: unknown, public manifest: unknown) {}
    addStatusBarItem() { return { setText() {} }; } addRibbonIcon() {} addCommand() {} addSettingTab() {} registerEvent() {} registerDomEvent() {}
    async loadData() { return host.saved; }
    async saveData(value: unknown) { if (host.failSave) throw new Error("SETTINGS_WRITE_FAILED"); host.saved = structuredClone(value); }
  },
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {}, Platform: { isDesktop: true },
  requestUrl: vi.fn(async (request: { url: string; body?: ArrayBuffer }) => {
    let response = host.handshake;
    if (request.url.endsWith("/devices")) response = { devices: [host.profile] };
    if (request.url.endsWith("/device/profile")) { const body = JSON.parse(new TextDecoder().decode(request.body)); if (body.expectedRevision !== host.profile.revision) throw new Error("PROFILE_STALE"); host.profile = { id: "device", name: body.name, revision: body.expectedRevision + 1, ciphertext: body.ciphertext }; response = host.profile; }
    return { status: host.status, headers: {}, arrayBuffer: new TextEncoder().encode(JSON.stringify(host.status === 200 ? response : { code: "UNAUTHORIZED" })).buffer };
  }),
}));
// The separate remembered-unlock tests exercise actual encryption and corruption. This fixture isolates host commit boundaries.
vi.mock("../../plugin/src/desktop/protector", () => ({ desktopProtector: () => ({ name: "host-test-only", protect: async (text: string) => new TextEncoder().encode(text), unprotect: async (bytes: Uint8Array) => new TextDecoder().decode(bytes) }) }));
import ObsidianSyncPlugin from "../../plugin/src/sync-main";
let instance: ObsidianSyncPlugin | undefined;
let databaseId: string;
let keyPackage: unknown;
const endpoint = "http://127.0.0.1:8873";
beforeEach(async () => {
  host.profile = { id: "device", name: "Fixture", revision: 0, ciphertext: "" }; host.saved = null; host.failSave = false; host.status = 200; host.files.clear(); host.handlers.clear(); databaseId = randomId(); vi.mocked(requestUrl).mockClear();
  vi.stubGlobal("window", {}); vi.stubGlobal("document", {});
  const created = await VaultCrypto.create("host-test-vault", "test-sync-key"); keyPackage = created.keyPackage; created.crypto.close();
  host.handshake = { protocol: 0, vaultId: "host-test-vault", epoch: "epoch", seq: 0, features: [...SYNC_FEATURES], keyPackage, devices: [{ id: "device", name: "Fixture" }], maxObjectBytes: 8388608 };
  host.files.set(".obsidian/obsidian-sync-development.json", JSON.stringify({ generatedBy: "ObsidianSync desktop test setup" }));
  host.files.set(".obsidian/obsidian-sync-local/device.json", JSON.stringify({ endpoint, token: "x".repeat(64), vaultId: "host-test-vault", deviceId: "device", deviceName: "Fixture", databaseId }));
});
afterEach(async () => { instance?.onunload(); instance = undefined; await new SyncDB(`obsidian-sync-dev-${databaseId}`).delete(); vi.unstubAllGlobals(); });
async function load() {
  const adapter = { exists: async (p: string) => host.files.has(p), read: async (p: string) => host.files.get(p)!, write: async (p: string, s: string) => { host.files.set(p, s); } };
  const app = { vault: { configDir: ".obsidian", adapter, on: (name: string, callback: (...args: unknown[]) => void) => { host.handlers.set(name, callback); } }, workspace: { onLayoutReady() {} } } as unknown as App;
  instance = new ObsidianSyncPlugin(app, { version: "0.0.6" } as PluginManifest); await instance.onload(); return instance;
}
it("saves an entered address with an immutable protected-key reference; pause and reload keep the key", async () => {
  const plugin = await load(); await plugin.saveConnection(" http://localhost:8873/ ", "test-sync-key");
  expect(plugin.endpoint).toBe("http://localhost:8873"); expect(plugin.engine?.unlocked).toBe(true);
  const saved = host.saved as { format: number; endpoint: string; record: string; autoSync: boolean };
  expect(saved).toMatchObject({ format: 3, endpoint: "http://localhost:8873", autoSync: true });
  expect(saved.record).toMatch(/^connection-[a-f0-9]{64}\.json$/); expect(JSON.stringify(saved)).not.toContain("test-sync-key");
  const encryptedRecord = host.files.get(`.obsidian/obsidian-sync-local/${saved.record}`);
  await plugin.setAutoSync(false); expect(host.saved).toMatchObject({ autoSync: false, record: saved.record });
  expect(host.files.get(`.obsidian/obsidian-sync-local/${saved.record}`)).toBe(encryptedRecord);
  plugin.onunload(); await Promise.resolve();
  const reloaded = await load();
  // Startup is normally invoked by Obsidian's layout callback, deliberately held by this fixture.
  await (reloaded as unknown as { startup(): Promise<void> }).startup();
  expect(reloaded.autoSync).toBe(false); expect(reloaded.engine?.unlocked).toBe(true);
  await reloaded.setAutoSync(true); expect(reloaded.engine?.unlocked).toBe(true);
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
  expect(host.saved).toMatchObject({ format: 3, endpoint: "http://localhost:8873" });
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
