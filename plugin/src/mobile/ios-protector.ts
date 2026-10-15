import sodium from "libsodium-wrappers-sumo";
import { z } from "zod";
import type { SecretProtector } from "../desktop/protector";
import type { UnlockIdentity } from "../desktop/remembered-unlock";
import { canonical } from "../../../protocol/src/model";
import { fingerprint, randomId } from "../sync/crypto";

// Obsidian's installed iOS host registers the native aparajita SecureStorage bridge.
// Per-call options avoid changing the host's shared Keychain defaults.
export interface IosKeychain {
  internalGetItem(options: { prefixedKey: string; sync: false }): Promise<{ data?: string | null }>;
  internalSetItem(options: { prefixedKey: string; data: string; sync: false; access: 1 }): Promise<unknown>;
  internalRemoveItem(options: { prefixedKey: string; sync: false }): Promise<unknown>;
}
export interface IosRuntime {
  Capacitor?: {
    getPlatform(): string;
    isNativePlatform(): boolean;
    isPluginAvailable(name: string): boolean;
    PluginHeaders?: { name: string; methods: { name: string; rtype?: string }[] }[];
    Plugins: { SecureStorage?: IosKeychain };
  };
}
const envelopeSchema = z.strictObject({
  format: z.literal(1), reference: z.string().regex(/^obsidian-sync-wrap-v1-[a-f0-9]{64}-[a-f0-9]{64}$/),
  nonce: z.string().regex(/^[a-f0-9]{48}$/), sealed: z.string().min(24).max(8192),
});
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function iosProtector(isIos: boolean, identity: UnlockIdentity, runtime?: IosRuntime): SecretProtector {
  const environment = runtime ?? (typeof window === "undefined" ? {} : window as unknown as IosRuntime);
  const cap = environment.Capacitor;
  const storage = cap?.Plugins.SecureStorage;
  const methods = cap?.PluginHeaders?.find(h => h.name === "SecureStorage")?.methods;
  if (!isIos || !cap || cap.getPlatform() !== "ios" || !cap.isNativePlatform() || !cap.isPluginAvailable("SecureStorage") || !storage
    || !["internalGetItem", "internalSetItem", "internalRemoveItem"].every(name => methods?.some(m => m.name === name && m.rtype === "promise"))
    || typeof storage.internalGetItem !== "function" || typeof storage.internalSetItem !== "function" || typeof storage.internalRemoveItem !== "function") {
    throw new Error("IOS_NATIVE_KEYCHAIN_UNAVAILABLE");
  }
  // Freeze the identity: callers cannot redirect an already-created protector to another device or server.
  const context = canonical({ purpose: "obsidiansync-ios-unlock-v1", ...identity });
  const prefix = fingerprint(encoder.encode(context)).then(hash => `obsidian-sync-wrap-v1-${hash}-`);
  async function read(reference: string): Promise<string> {
    let result: { data?: string | null };
    try { result = await storage!.internalGetItem({ prefixedKey: reference, sync: false }); }
    catch { throw new Error("IOS_KEYCHAIN_READ_FAILED"); }
    if (typeof result?.data !== "string" || !/^[a-f0-9]{64}$/.test(result.data)) throw new Error("IOS_KEYCHAIN_KEY_UNAVAILABLE");
    return result.data;
  }
  return {
    name: "ios-keychain:when-unlocked-this-device-only:v1",
    async protect(plaintext) {
      await sodium.ready;
      const reference = await prefix + randomId();
      const key = sodium.randombytes_buf(32);
      let mayHaveWritten = false;
      try {
        const prior = await storage.internalGetItem({ prefixedKey: reference, sync: false });
        if (prior.data != null && prior.data !== "") throw new Error("IOS_KEYCHAIN_REFERENCE_OCCUPIED");
        const nonce = sodium.randombytes_buf(24);
        const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(encoder.encode(plaintext), context + reference, null, nonce, key);
        const envelope = encoder.encode(JSON.stringify({ format: 1, reference, nonce: sodium.to_hex(nonce), sealed: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL) }));
        if (envelope.length > 8192) throw new Error("IOS_SECURE_RECORD_TOO_LARGE");
        mayHaveWritten = true;
        // access=1: WhenUnlockedThisDeviceOnly. sync=false: never iCloud Keychain.
        await storage.internalSetItem({ prefixedKey: reference, data: sodium.to_hex(key), sync: false, access: 1 });
        if (await read(reference) !== sodium.to_hex(key)) throw new Error("IOS_KEYCHAIN_WRITE_INCOMPLETE");
        return envelope;
      } catch (error) {
        if (mayHaveWritten) {
          // This random reference was absent before this attempt. Never clear a prefix or another record.
          try { await storage.internalRemoveItem({ prefixedKey: reference, sync: false }); } catch { /* An unreachable orphan stays protected in Keychain. */ }
        }
        const code = error instanceof Error ? error.message : "";
        if (["IOS_KEYCHAIN_REFERENCE_OCCUPIED", "IOS_SECURE_RECORD_TOO_LARGE", "IOS_KEYCHAIN_WRITE_INCOMPLETE", "IOS_KEYCHAIN_KEY_UNAVAILABLE", "IOS_KEYCHAIN_READ_FAILED"].includes(code)) throw error;
        throw new Error("IOS_KEYCHAIN_WRITE_FAILED");
      } finally { sodium.memzero(key); }
    },
    async unprotect(ciphertext) {
      await sodium.ready;
      if (ciphertext.length > 8192) throw new Error("IOS_SECURE_RECORD_TOO_LARGE");
      const envelope = envelopeSchema.parse(JSON.parse(decoder.decode(ciphertext)));
      if (!envelope.reference.startsWith(await prefix)) throw new Error("IOS_KEYCHAIN_IDENTITY_MISMATCH");
      const key = sodium.from_hex(await read(envelope.reference));
      try {
        const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,
          sodium.from_base64(envelope.sealed, sodium.base64_variants.ORIGINAL), context + envelope.reference, sodium.from_hex(envelope.nonce), key);
        try { return decoder.decode(plaintext); } finally { sodium.memzero(plaintext); }
      } finally { sodium.memzero(key); }
    },
  };
}
