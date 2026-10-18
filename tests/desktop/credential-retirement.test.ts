import { expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ getLanguage: () => "zh", Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {}, MarkdownView: class {}, Platform: { isDesktop: false, isIosApp: true }, requestUrl: vi.fn() }));
import ObsidianSyncPlugin from "../../plugin/src/sync-main";
import { RememberedUnlock, type StoredMaterial } from "../../plugin/src/desktop/remembered-unlock";
import { iosProtector, type IosRuntime, type IosKeychain } from "../../plugin/src/mobile/ios-protector";
import { VaultCrypto } from "../../plugin/src/sync/crypto";

type Boundary = "journal-read" | "journal-write-before" | "journal-write-after" | "key-remove-before" | "key-remove-after" |
  "file-remove-before" | "file-remove-after" | "journal-remove-before" | "journal-remove-after";
interface CleanupOwner { cleanupConnectionRecords(): Promise<void> }
async function fixture() {
  const identity = { vaultId: "retirement-vault", deviceId: "retirement-device", databaseId: "retirement-db", endpoint: "https://fixture.invalid" };
  const root = ".obsidian/obsidian-sync-local", oldName = `connection-${"a".repeat(64)}.json`, activeName = `connection-${"b".repeat(64)}.json`;
  const files = new Map<string, string>(), keys = new Map<string, string>();
  let fault: ((boundary: Boundary, path: string) => Promise<void>) | undefined;
  const storage: IosKeychain = {
    internalGetItem: async ({ prefixedKey }) => ({ data: keys.get(prefixedKey) ?? null }),
    internalSetItem: async ({ prefixedKey, data }) => { keys.set(prefixedKey, data); },
    internalRemoveItem: async ({ prefixedKey }) => {
      await fault?.("key-remove-before", prefixedKey);
      if (!keys.delete(prefixedKey)) throw new Error("NATIVE_KEY_ALREADY_ABSENT");
      await fault?.("key-remove-after", prefixedKey);
    },
  };
  const runtime: IosRuntime = { Capacitor: { getPlatform: () => "ios", isNativePlatform: () => true, isPluginAvailable: () => true,
    PluginHeaders: [{ name: "SecureStorage", methods: Object.keys(storage).map(name => ({ name, rtype: "promise" })) }], Plugins: { SecureStorage: storage } } };
  const adapter = {
    list: async () => ({ files: [...files.keys()], folders: [] }), exists: async (path: string) => files.has(path), read: async (path: string) => { if (path.endsWith(".retiring")) await fault?.("journal-read", path); return files.get(path)!; },
    write: async (path: string, value: string) => {
      if (path.endsWith(".retiring")) await fault?.("journal-write-before", path);
      files.set(path, value);
      if (path.endsWith(".retiring")) await fault?.("journal-write-after", path);
    },
    remove: async (path: string) => {
      const journal = path.endsWith(".retiring");
      await fault?.(journal ? "journal-remove-before" : "file-remove-before", path);
      files.delete(path);
      await fault?.(journal ? "journal-remove-after" : "file-remove-after", path);
    },
  };
  const store = (name: string, endpoint = identity.endpoint) => {
    const context = { ...identity, endpoint };
    return new RememberedUnlock(adapter, `${root}/${name}`, context, iosProtector(true, context, runtime));
  };
  const created = await VaultCrypto.create(identity.vaultId, "public-retirement-test-only");
  const material: StoredMaterial = { format: 0, vaultId: identity.vaultId, keyPackageFingerprint: "a".repeat(64), session: created.crypto.sessionMaterial(), token: "t".repeat(64) };
  created.crypto.close(); await store(oldName).save(material); await store(activeName).save(material);
  const cleanup = async (current = activeName, endpoint = identity.endpoint): Promise<void> => {
    const owner = Object.assign(Object.create(ObsidianSyncPlugin.prototype) as CleanupOwner, {
      app: { vault: { adapter } }, root, endpoint, connectionRecord: current, remembered: store(current, endpoint),
      unlockStore: (endpoint: string, name: string) => store(name, endpoint),
    });
    await owner.cleanupConnectionRecords();
  };
  return { identity, root, oldName, activeName, files, keys, store, material, cleanup,
    setFault(callback?: (boundary: Boundary, path: string) => Promise<void>) { fault = callback; } };
}

it.each<Boundary>(["journal-write-before", "journal-write-after", "key-remove-before", "key-remove-after", "file-remove-before", "file-remove-after", "journal-remove-before", "journal-remove-after"])("restarts credential retirement after %s and keeps the active record usable", async boundary => {
  const f = await fixture(); let interrupted = false;
  f.setFault(async point => { if (!interrupted && point === boundary) { interrupted = true; throw new Error("RETIREMENT_INTERRUPTED"); } });
  await expect(f.store(f.oldName).retire(f.store(f.activeName))).rejects.toThrow("RETIREMENT_INTERRUPTED");
  expect(interrupted).toBe(true); expect(await f.store(f.activeName).load()).toEqual(f.material);
  f.setFault(); await f.cleanup(); await f.cleanup();
  expect(f.files.has(`${f.root}/${f.oldName}`)).toBe(false); expect(f.files.has(`${f.root}/${f.oldName}.retiring`)).toBe(false);
  expect(f.keys.size).toBe(1); expect(await f.store(f.activeName).load()).toEqual(f.material);
});

it.each(["address", "token"])("prepares retirement before the %s pointer switch and only deletes the old wrapping key after it", async kind => {
  const f = await fixture();
  await f.store(f.activeName).retire();
  const endpoint = kind === "address" ? "https://next.fixture.invalid" : f.identity.endpoint;
  const material = { ...f.material, token: kind === "token" ? "n".repeat(64) : f.material.token };
  await f.store(f.activeName, endpoint).save(material);
  const original = f.files.get(`${f.root}/${f.oldName}`);
  await f.store(f.oldName).prepareRetirement();
  // A restart before the settings pointer commits must continue using the old key.
  await f.cleanup(f.oldName);
  expect(f.files.get(`${f.root}/${f.oldName}`)).toBe(original);
  expect(await f.store(f.oldName).load()).toEqual(f.material); expect(f.keys.size).toBe(2);
  expect(f.files.has(`${f.root}/${f.oldName}.retiring`)).toBe(true);
  // After the pointer commits, the journal supplies the old binding even across an address change.
  await f.cleanup(f.activeName, endpoint); await f.cleanup(f.activeName, endpoint);
  expect(f.files.has(`${f.root}/${f.oldName}`)).toBe(false);
  expect(f.files.has(`${f.root}/${f.oldName}.retiring`)).toBe(false); expect(f.keys.size).toBe(1);
  expect(await f.store(f.activeName, endpoint).load()).toEqual(material);
});

it("retains a new credential written at the retiring path while native deletion is in flight", async () => {
  const f = await fixture(), newer = { ...f.material, token: "n".repeat(64) }; let replaced = false;
  f.setFault(async point => { if (!replaced && point === "key-remove-after") { replaced = true; await f.store(f.oldName).save(newer); } });
  await f.store(f.oldName).retire(f.store(f.activeName)); f.setFault(); await f.cleanup();
  expect(replaced).toBe(true); expect(await f.store(f.oldName).load()).toEqual(newer);
  expect(await f.store(f.activeName).load()).toEqual(f.material); expect(f.keys.size).toBe(2);
  expect(f.files.has(`${f.root}/${f.oldName}.retiring`)).toBe(false);
});

it("does not delete a wrapping key still referenced by the active record", async () => {
  const f = await fixture(); await f.store(f.activeName).retire();
  f.files.set(`${f.root}/${f.activeName}`, f.files.get(`${f.root}/${f.oldName}`)!);
  await f.store(f.oldName).retire(f.store(f.activeName));
  expect(f.keys.size).toBe(1); expect(await f.store(f.activeName).load()).toEqual(f.material);
});

it("does not resume a retirement journal against a path that is now the active pointer", async () => {
  const f = await fixture(); let interrupted = false;
  f.setFault(async point => { if (!interrupted && point === "journal-write-after") { interrupted = true; throw new Error("RETIREMENT_INTERRUPTED"); } });
  await expect(f.store(f.oldName).retire(f.store(f.activeName))).rejects.toThrow("RETIREMENT_INTERRUPTED");
  f.setFault(); await f.cleanup(f.oldName);
  expect(await f.store(f.oldName).load()).toEqual(f.material); expect(f.keys.size).toBe(1);
  expect(f.files.has(`${f.root}/${f.oldName}.retiring`)).toBe(true);
  await f.store(f.oldName).retire(f.store(f.oldName)); expect(await f.store(f.oldName).load()).toEqual(f.material);
});

it("rebuilds a torn retirement journal from the untouched protected original", async () => {
  const f = await fixture(); let torn = false;
  f.setFault(async (point, path) => { if (!torn && point === "journal-write-after") { torn = true; f.files.set(path, "{truncated"); throw new Error("TORN_JOURNAL"); } });
  await expect(f.store(f.oldName).retire(f.store(f.activeName))).rejects.toThrow("TORN_JOURNAL");
  expect(f.keys.size).toBe(2); expect(await f.store(f.oldName).load()).toEqual(f.material);
  f.setFault(); await f.cleanup();
  expect(f.keys.size).toBe(1); expect(f.files.has(`${f.root}/${f.oldName}`)).toBe(false);
  expect(await f.store(f.activeName).load()).toEqual(f.material);
});

it("resumes a retired credential with its original server binding after the active endpoint changes", async () => {
  const f = await fixture(); await f.store(f.oldName).retire(f.store(f.activeName));
  const oldEndpoint = "https://previous.fixture.invalid";
  await f.store(f.oldName, oldEndpoint).save(f.material); let interrupted = false;
  f.setFault(async point => { if (!interrupted && point === "file-remove-before") { interrupted = true; throw new Error("OLD_ENDPOINT_INTERRUPTED"); } });
  await expect(f.store(f.oldName, oldEndpoint).retire(f.store(f.activeName))).rejects.toThrow("OLD_ENDPOINT_INTERRUPTED");
  f.setFault(); await f.cleanup();
  expect(f.files.has(`${f.root}/${f.oldName}`)).toBe(false); expect(f.keys.size).toBe(1);
  expect(await f.store(f.activeName).load()).toEqual(f.material);
});

it("preserves a temporarily unreadable retirement journal instead of replacing its evidence", async () => {
  const f = await fixture(); let interrupted = false;
  f.setFault(async point => { if (!interrupted && point === "journal-write-after") { interrupted = true; throw new Error("RETIREMENT_INTERRUPTED"); } });
  await expect(f.store(f.oldName).retire(f.store(f.activeName))).rejects.toThrow("RETIREMENT_INTERRUPTED");
  const journal = f.files.get(`${f.root}/${f.oldName}.retiring`);
  f.setFault(async point => { if (point === "journal-read") throw new Error("JOURNAL_UNREADABLE"); });
  await f.cleanup();
  expect(f.files.get(`${f.root}/${f.oldName}.retiring`)).toBe(journal); expect(f.keys.size).toBe(2);
  expect(await f.store(f.activeName).load()).toEqual(f.material);
  f.setFault(); await f.cleanup(); expect(f.keys.size).toBe(1);
});
