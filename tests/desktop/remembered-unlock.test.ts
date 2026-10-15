import { expect, it, vi } from "vitest";
import { desktopProtector, type SecretProtector } from "../../plugin/src/desktop/protector";
import { RememberedUnlock, type LocalTextFiles } from "../../plugin/src/desktop/remembered-unlock";
import { VaultCrypto } from "../../plugin/src/sync/crypto";

async function protector(): Promise<SecretProtector> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { name: "test-only-aes-machine-protector",
    async protect(plain) { const nonce = crypto.getRandomValues(new Uint8Array(12)); const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(plain)); const bytes = new Uint8Array(12 + cipher.byteLength); bytes.set(nonce); bytes.set(new Uint8Array(cipher), 12); return bytes; },
    async unprotect(bytes) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12))); },
  };
}
const identity = { vaultId: "remembered-vault", deviceId: "device-a", databaseId: "database-a", endpoint: "http://127.0.0.1:8873" };
it("reports protected-record presence without native decryption, excluding tombstones and malformed records", async () => {
  let disk: string | undefined;
  const unprotect = vi.fn(async () => { throw new Error("NATIVE_STORE_LOCKED"); });
  const adapter: LocalTextFiles = { exists: async () => disk !== undefined, read: async () => disk!, write: async (_path, value) => { disk = value; } };
  const remember = new RememberedUnlock(adapter, "local/unlock", identity, { name: "test-provider", protect: async () => new Uint8Array([1]), unprotect });
  expect(await remember.hasRecord()).toBe(false);
  disk = JSON.stringify({ format: 0, provider: "test-provider", ciphertext: [1, 2, 3] });
  expect(await remember.hasRecord()).toBe(true); expect(unprotect).not.toHaveBeenCalled();
  await expect(remember.load()).rejects.toThrow("NATIVE_STORE_LOCKED"); expect(await remember.hasRecord()).toBe(true);
  await remember.clear(); expect(await remember.hasRecord()).toBe(false);
  disk = "{truncated"; expect(await remember.hasRecord()).toBe(false);
  disk = JSON.stringify({ format: 0, provider: "test-provider", ciphertext: [] }); expect(await remember.hasRecord()).toBe(false);
});
it("persists only protected session material, restores exact keys and leaves no passphrase", async () => {
  const files = new Map<string, string>(); const adapter: LocalTextFiles = { exists: async p => files.has(p), read: async p => files.get(p)!, write: async (p, s) => { files.set(p, s); } };
  const os = await protector(); const remember = new RememberedUnlock(adapter, "local/unlock", identity, os);
  const created = await VaultCrypto.create(identity.vaultId, "public-test-passphrase");
  const material = { format: 0 as const, vaultId: identity.vaultId, keyPackageFingerprint: "a".repeat(64), session: created.crypto.sessionMaterial() };
  const oldObject = created.crypto.object(new TextEncoder().encode("retained snapshot"));
  await remember.save(material); created.crypto.close(); expect(() => created.crypto.sessionMaterial()).toThrow("LOCKED");
  const disk = files.get("local/unlock")!; expect(disk).not.toContain("public-test-passphrase"); expect(disk).not.toContain(material.session.content); expect(JSON.parse(disk).session).toBeUndefined();
  const restored = await remember.load(); expect(restored).toEqual(material);
  const tampered = { ...restored!.session, content: "b".repeat(64) };
  await expect(VaultCrypto.restore(identity.vaultId, tampered)).rejects.toThrow("INVALID_SESSION_MATERIAL");
  const keys = await VaultCrypto.restore(identity.vaultId, restored!.session); expect(new TextDecoder().decode(keys.decryptObject(oldObject.id, oldObject.bytes))).toBe("retained snapshot"); keys.close();
  await remember.clear(); expect(await remember.load()).toBe(null);
});
it("rejects copied device records, other machine keys and corruption without clearing the original", async () => {
  let disk = ""; const adapter: LocalTextFiles = { exists: async () => !!disk, read: async () => disk, write: async (_p, s) => { disk = s; } };
  const os = await protector(); const created = await VaultCrypto.create(identity.vaultId, "public-test");
  const remember = new RememberedUnlock(adapter, "local/unlock", identity, os);
  await remember.save({ format: 0, vaultId: identity.vaultId, keyPackageFingerprint: "a".repeat(64), session: created.crypto.sessionMaterial() }); created.crypto.close();
  const original = disk;
  await expect(new RememberedUnlock(adapter, "local/unlock", { ...identity, deviceId: "device-b" }, os).load()).rejects.toThrow("UNLOCK_IDENTITY_MISMATCH"); expect(disk).toBe(original);
  await expect(new RememberedUnlock(adapter, "local/unlock", identity, await protector()).load()).rejects.toThrow(); expect(disk).toBe(original);
  disk = original.slice(0, -3); await expect(remember.load()).rejects.toThrow(); expect(disk).toBe(original.slice(0, -3));
});
it("never loads desktop modules on mobile and refuses unavailable/plaintext Linux providers", () => {
  const load = vi.fn(); expect(() => desktopProtector(false, load)).toThrow("DESKTOP_SECURE_STORAGE_REQUIRED"); expect(load).not.toHaveBeenCalled();
  const encryptString = vi.fn(); const modules = { safeStorage: { isEncryptionAvailable: () => false, encryptString, decryptString: () => "" }, platform: "darwin", bufferFrom: (b: Uint8Array) => b };
  expect(() => desktopProtector(true, () => modules)).toThrow("DESKTOP_SECURE_STORAGE_UNAVAILABLE"); expect(encryptString).not.toHaveBeenCalled();
  expect(() => desktopProtector(true, () => ({ ...modules, platform: "linux", safeStorage: { ...modules.safeStorage, isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" } }))).toThrow("INSECURE_STORAGE_BACKEND");
});
