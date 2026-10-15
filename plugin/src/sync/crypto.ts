import sodium from "libsodium-wrappers-sumo";
import { z } from "zod";
import { canonical } from "../../../protocol/src/model";
import type { Location, Payload, Revision } from "../../../protocol/src/types";

export const MAX_FILE_BYTES = 100_000_000;
export const randomId = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, "0")).join("");
export const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
const unb64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
const envelopeSchema = z.strictObject({ v: z.literal(0), n: z.string().max(64), c: z.string().max(Math.ceil((MAX_FILE_BYTES + 16) / 3) * 4) });
const keyPackageSchema = z.strictObject({ format: z.literal(0), vaultId: z.string(), kdf: z.literal("Argon2id13"), memory: z.literal(67108864), ops: z.literal(2), salt: z.string().max(64), wrapped: envelopeSchema });
export type KeyPackage = z.infer<typeof keyPackageSchema>;
const text = new TextEncoder();
function seal(key: Uint8Array, bytes: Uint8Array, context: unknown): string {
  const nonce = sodium.randombytes_buf(24);
  return JSON.stringify({ v: 0, n: b64(nonce), c: b64(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(bytes, canonical(context), null, nonce, key)) });
}
function open(key: Uint8Array, encrypted: string, context: unknown): Uint8Array {
  const e = envelopeSchema.parse(JSON.parse(encrypted));
  const nonce = unb64(e.n); if (nonce.length !== 24) throw new Error("INVALID_NONCE");
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(e.c), canonical(context), nonce, key);
}
export function canonicalPath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.length > 1024) throw new Error("UNSAFE_PATH");
  for (const [index, part] of path.split("/").entries()) {
    if (!part || part === "." || part === ".." || (part.startsWith(".") && !(index === 0 && part === ".obsidian")) || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)) throw new Error("UNSUPPORTED_PATH");
  }
  return path.normalize("NFC").toLowerCase();
}
function revisionContext(r: Revision): unknown {
  return { purpose: "manifest-v0", vaultId: "", fileId: r.fileId, revisionId: r.id, parents: r.parents,
    deviceId: r.deviceId, kind: r.payload.kind, keyEpoch: r.payload.keyEpoch, objects: r.payload.objects, selectedFrom: r.selectedFrom ?? null };
}
const manifestSchema = z.strictObject({ format: z.literal(0), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), length: z.number().int().min(0).max(MAX_FILE_BYTES) });
const keyHex = z.string().regex(/^[a-f0-9]{64}$/);
const sessionSchema = z.strictObject({ format: z.literal(0), vaultId: z.string(), content: keyHex, metadata: keyHex, paths: keyHex, local: keyHex, auth: keyHex });
export type SessionMaterial = z.infer<typeof sessionSchema>;
function sessionTag(material: Omit<SessionMaterial, "auth">): Uint8Array {
  const local = sodium.from_hex(material.local);
  const checkKey = sodium.crypto_generichash(32, text.encode("obsidiansync:device-session-integrity-v0"), local);
  try { return sodium.crypto_generichash(32, text.encode(canonical(material)), checkKey); }
  finally { sodium.memzero(local); sodium.memzero(checkKey); }
}

export class VaultCrypto {
  private content: Uint8Array;
  private metadata: Uint8Array;
  private paths: Uint8Array;
  private local: Uint8Array;
  private closed = false;
  private constructor(readonly vaultId: string, master: Uint8Array | null, restored?: SessionMaterial) {
    if (master) {
      const derive = (purpose: string) => sodium.crypto_generichash(32, text.encode(`obsidiansync-v0:${vaultId}:${purpose}`), master);
      this.content = derive("content"); this.metadata = derive("metadata"); this.paths = derive("paths"); this.local = derive("local"); sodium.memzero(master);
    } else {
      if (!restored || restored.vaultId !== vaultId) throw new Error("WRONG_VAULT");
      this.content = sodium.from_hex(restored.content); this.metadata = sodium.from_hex(restored.metadata);
      this.paths = sodium.from_hex(restored.paths); this.local = sodium.from_hex(restored.local);
    }
  }
  static async create(vaultId: string, passphrase: string): Promise<{ crypto: VaultCrypto; keyPackage: KeyPackage }> {
    await sodium.ready;
    const salt = sodium.randombytes_buf(16); const master = sodium.randombytes_buf(32);
    const wrapping = sodium.crypto_pwhash(32, passphrase, salt, 2, 67108864, sodium.crypto_pwhash_ALG_ARGON2ID13);
    try {
      const header = { format: 0 as const, vaultId, kdf: "Argon2id13" as const, memory: 67108864 as const, ops: 2 as const, salt: b64(salt) };
      const wrapped = JSON.parse(seal(wrapping, master, header)) as z.infer<typeof envelopeSchema>;
      return { crypto: new VaultCrypto(vaultId, master), keyPackage: { ...header, wrapped } };
    } finally { sodium.memzero(wrapping); sodium.memzero(master); }
  }
  static async unlock(vaultId: string, input: unknown, passphrase: string): Promise<VaultCrypto> {
    await sodium.ready; const pkg = keyPackageSchema.parse(input);
    if (pkg.vaultId !== vaultId) throw new Error("WRONG_VAULT"); const { wrapped, ...header } = pkg;
    const salt = unb64(pkg.salt); if (salt.length !== 16) throw new Error("INVALID_SALT");
    const wrapping = sodium.crypto_pwhash(32, passphrase, salt, pkg.ops, pkg.memory, sodium.crypto_pwhash_ALG_ARGON2ID13);
    try { const master = open(wrapping, JSON.stringify(wrapped), header); if (master.length !== 32) throw new Error("INVALID_MASTER_KEY"); return new VaultCrypto(vaultId, master); }
    finally { sodium.memzero(wrapping); }
  }
  /** Secret material: only pass directly to the device protector; never write/log/transfer plaintext. */
  sessionMaterial(): SessionMaterial {
    if (this.closed) throw new Error("LOCKED");
    const material = { format: 0 as const, vaultId: this.vaultId, content: sodium.to_hex(this.content), metadata: sodium.to_hex(this.metadata), paths: sodium.to_hex(this.paths), local: sodium.to_hex(this.local) };
    return { ...material, auth: sodium.to_hex(sessionTag(material)) };
  }
  static async restore(vaultId: string, input: unknown): Promise<VaultCrypto> {
    await sodium.ready; const material = sessionSchema.parse(input);
    if (material.vaultId !== vaultId) throw new Error("WRONG_VAULT");
    const { auth, ...body } = material;
    if (!sodium.memcmp(sessionTag(body), sodium.from_hex(auth))) throw new Error("INVALID_SESSION_MATERIAL");
    return new VaultCrypto(vaultId, null, material);
  }
  close(): void { this.closed = true; for (const k of [this.content, this.metadata, this.paths, this.local]) sodium.memzero(k); }
  pathKey(path: string): string { return sodium.to_hex(sodium.crypto_generichash(32, text.encode(canonicalPath(path)), this.paths)); }
  location(fileId: string, path: string): Location {
    const revision = randomId(); const pathKey = this.pathKey(path);
    const encryptedPath = seal(this.metadata, text.encode(path), { purpose: "path-v0", vaultId: this.vaultId, keyEpoch: 1, fileId, revision, pathKey });
    return { revision, pathKey, encryptedPath };
  }
  path(fileId: string, l: Location): string {
    const bytes = open(this.metadata, l.encryptedPath, { purpose: "path-v0", vaultId: this.vaultId, keyEpoch: 1, fileId, revision: l.revision, pathKey: l.pathKey });
    const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (this.pathKey(path) !== l.pathKey) throw new Error("PATH_KEY_MISMATCH"); return path;
  }
  object(bytes: Uint8Array): { id: string; bytes: Uint8Array } {
    const id = randomId(); return { id, bytes: text.encode(seal(this.content, bytes, { purpose: "object-v0", vaultId: this.vaultId, keyEpoch: 1, blobId: id })) };
  }
  decryptObject(id: string, bytes: Uint8Array): Uint8Array {
    return open(this.content, new TextDecoder().decode(bytes), { purpose: "object-v0", vaultId: this.vaultId, keyEpoch: 1, blobId: id });
  }
  async payload(r: Omit<Revision, "payload">, bytes: Uint8Array, kind: Payload["kind"], objects: string[]): Promise<Payload> {
    const payload: Payload = { kind, keyEpoch: 1, objects, encryptedManifest: "" };
    const ctx = { ...revisionContext({ ...r, payload }) as Record<string, unknown>, vaultId: this.vaultId };
    payload.encryptedManifest = seal(this.metadata, text.encode(JSON.stringify({ format: 0, fingerprint: await fingerprint(bytes), length: bytes.length })), ctx);
    return payload;
  }
  manifest(r: Revision): z.infer<typeof manifestSchema> {
    return manifestSchema.parse(JSON.parse(new TextDecoder().decode(open(this.metadata, r.payload.encryptedManifest,
      { ...revisionContext(r) as Record<string, unknown>, vaultId: this.vaultId }))));
  }
  profileSeal(deviceId: string, revision: number, value: unknown): string { return seal(this.metadata, text.encode(JSON.stringify(value)), { purpose: "device-profile-v1", vaultId: this.vaultId, deviceId, revision }); }
  profileOpen(deviceId: string, revision: number, ciphertext: string): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(open(this.metadata, ciphertext, { purpose: "device-profile-v1", vaultId: this.vaultId, deviceId, revision }))); }
  localSeal(id: string, bytes: Uint8Array): Uint8Array { return text.encode(seal(this.local, bytes, { purpose: "local-v0", vaultId: this.vaultId, id })); }
  localOpen(id: string, bytes: Uint8Array): Uint8Array { return open(this.local, new TextDecoder().decode(bytes), { purpose: "local-v0", vaultId: this.vaultId, id }); }
}
