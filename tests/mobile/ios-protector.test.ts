import { expect, it, vi } from "vitest";
import { iosProtector, type IosKeychain, type IosRuntime } from "../../plugin/src/mobile/ios-protector";
import { RememberedUnlock } from "../../plugin/src/desktop/remembered-unlock";
import { VaultCrypto } from "../../plugin/src/sync/crypto";

const identity = { vaultId: "test-vault", deviceId: "test-iphone", databaseId: "test-db", endpoint: "https://sync.example.com" };
function fixture() {
  const items = new Map<string, string>();
  const storage: IosKeychain = {
    internalGetItem: vi.fn(async ({ prefixedKey }) => ({ data: items.get(prefixedKey) ?? null })),
    internalSetItem: vi.fn(async ({ prefixedKey, data }) => { items.set(prefixedKey, data); }),
    internalRemoveItem: vi.fn(async ({ prefixedKey }) => { items.delete(prefixedKey); }),
  };
  const runtime: IosRuntime = { Capacitor: {
    getPlatform: () => "ios", isNativePlatform: () => true, isPluginAvailable: () => true,
    PluginHeaders: [{ name: "SecureStorage", methods: Object.keys(storage).map(name => ({ name, rtype: "promise" })) }],
    Plugins: { SecureStorage: storage },
  } };
  return { items, storage, runtime };
}
it("refuses non-iOS, web fallbacks and missing native methods before reading or writing anything", () => {
  const { storage, runtime } = fixture();
  expect(() => iosProtector(false, identity, runtime)).toThrow("IOS_NATIVE_KEYCHAIN_UNAVAILABLE");
  runtime.Capacitor!.isNativePlatform = () => false;
  expect(() => iosProtector(true, identity, runtime)).toThrow("IOS_NATIVE_KEYCHAIN_UNAVAILABLE");
  runtime.Capacitor!.isNativePlatform = () => true; runtime.Capacitor!.PluginHeaders = [];
  expect(() => iosProtector(true, identity, runtime)).toThrow("IOS_NATIVE_KEYCHAIN_UNAVAILABLE");
  expect(storage.internalGetItem).not.toHaveBeenCalled(); expect(storage.internalSetItem).not.toHaveBeenCalled();
});
it("keeps only random wrapping keys in non-syncing device-only Keychain and restores ciphertext with a new protector", async () => {
  const f = fixture(); const secret = "synthetic-unlock-material-never-plaintext-on-disk";
  const protector = iosProtector(true, identity, f.runtime);
  const record = await protector.protect(secret);
  expect(new TextDecoder().decode(record)).not.toContain(secret);
  expect([...f.items.values()]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  expect(f.storage.internalSetItem).toHaveBeenCalledWith(expect.objectContaining({ sync: false, access: 1 }));
  expect(await iosProtector(true, { ...identity }, f.runtime).unprotect(record)).toBe(secret);
  expect(f.storage.internalGetItem).toHaveBeenLastCalledWith(expect.objectContaining({ sync: false }));
});
it("binds references to the exact identity and authenticates altered encrypted records", async () => {
  const f = fixture(); const p = iosProtector(true, identity, f.runtime); const record = await p.protect("synthetic");
  for (const field of ["vaultId", "deviceId", "databaseId", "endpoint"] as const) {
    vi.mocked(f.storage.internalGetItem).mockClear();
    await expect(iosProtector(true, { ...identity, [field]: "other" }, f.runtime).unprotect(record)).rejects.toThrow("IOS_KEYCHAIN_IDENTITY_MISMATCH");
    expect(f.storage.internalGetItem).not.toHaveBeenCalled();
  }
  const damaged = JSON.parse(new TextDecoder().decode(record)); damaged.nonce = (damaged.nonce[0] === "0" ? "1" : "0") + damaged.nonce.slice(1);
  await expect(p.unprotect(new TextEncoder().encode(JSON.stringify(damaged)))).rejects.toThrow();
  const oldSize = f.items.size; f.items.clear();
  await expect(p.unprotect(record)).rejects.toThrow("IOS_KEYCHAIN_KEY_UNAVAILABLE");
  expect(oldSize).toBe(1); expect(f.items.size).toBe(0); expect(f.storage.internalSetItem).toHaveBeenCalledTimes(1);
});
it("awaits native persistence and readback before returning a protected record", async () => {
  const f = fixture(); let finish: (() => void) | undefined;
  f.storage.internalSetItem = vi.fn(({ prefixedKey, data }) => new Promise(resolve => { finish = () => { f.items.set(prefixedKey, data); resolve(undefined); }; }));
  let completed = false; const pending = iosProtector(true, identity, f.runtime).protect("synthetic").then(r => { completed = true; return r; });
  await vi.waitFor(() => expect(finish).toBeDefined()); expect(completed).toBe(false); finish!();
  await pending; expect(completed).toBe(true);
});
it("cleans only the failed new reference and preserves a previously valid record", async () => {
  const f = fixture(); const p = iosProtector(true, identity, f.runtime); const good = await p.protect("retained");
  const prior = [...f.items.keys()][0]!;
  f.storage.internalSetItem = vi.fn(async () => { throw new Error("native exception with secret data"); });
  await expect(p.protect("new-secret")).rejects.toThrow("IOS_KEYCHAIN_WRITE_FAILED");
  expect(f.storage.internalRemoveItem).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.storage.internalRemoveItem).mock.calls[0]![0].prefixedKey).not.toBe(prior);
  expect(await p.unprotect(good)).toBe("retained");
});
it("does not accept a native success acknowledgment whose durable readback contains a different key", async () => {
  const f = fixture(); const p = iosProtector(true, identity, f.runtime); const good = await p.protect("retained");
  f.storage.internalSetItem = vi.fn(async ({ prefixedKey, data }) => {
    f.items.set(prefixedKey, (data[0] === "0" ? "1" : "0") + data.slice(1));
  });
  await expect(p.protect("new-material")).rejects.toThrow("IOS_KEYCHAIN_WRITE_INCOMPLETE");
  expect(f.items.size).toBe(1); expect(f.storage.internalRemoveItem).toHaveBeenCalledTimes(1);
  expect(await p.unprotect(good)).toBe("retained");
});
it("integrates with immutable remembered-unlock files without writing passphrase or session keys", async () => {
  const f = fixture(); const files = new Map<string, string>();
  const adapter = { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p)!, write: async (p: string, data: string) => { files.set(p, data); } };
  const created = await VaultCrypto.create(identity.vaultId, "public-test-passphrase");
  const material = { format: 0 as const, vaultId: identity.vaultId, keyPackageFingerprint: "a".repeat(64), session: created.crypto.sessionMaterial() }; created.crypto.close();
  const remembered = new RememberedUnlock(adapter, "connection.json", identity, iosProtector(true, identity, f.runtime));
  await remembered.save(material);
  const bytes = files.get("connection.json")!;
  expect(bytes).not.toContain("public-test-passphrase"); expect(bytes).not.toContain(material.session.content); expect(bytes).not.toContain(material.session.local);
  const restored = new RememberedUnlock(adapter, "connection.json", identity, iosProtector(true, identity, f.runtime));
  expect(await restored.load()).toEqual(material);
  f.items.clear(); await expect(restored.load()).rejects.toThrow("IOS_KEYCHAIN_KEY_UNAVAILABLE"); expect(files.get("connection.json")).toBe(bytes);
});

it("retires only the exact wrapping key and rejects a foreign identity before deletion", async () => {
  const f=fixture(), p=iosProtector(true,identity,f.runtime);
  const old=await p.protect("old"), current=await p.protect("current");
  await expect(iosProtector(true,{...identity,deviceId:"foreign"},f.runtime).forget!(old)).rejects.toThrow("IOS_KEYCHAIN_IDENTITY_MISMATCH");
  expect(f.storage.internalRemoveItem).not.toHaveBeenCalled();
  await p.forget!(old); expect(f.items.size).toBe(1); expect(await p.unprotect(current)).toBe("current");
  await p.forget!(current,current); expect(f.items.size).toBe(1); expect(await p.unprotect(current)).toBe("current");
  await expect(p.unprotect(old)).rejects.toThrow("IOS_KEYCHAIN_KEY_UNAVAILABLE");
});
