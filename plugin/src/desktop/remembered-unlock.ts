import { z } from "zod";
import type { SecretProtector } from "./protector";
import type { RememberedMaterial } from "../sync/engine";
import { enrollmentSchema, type Enrollment } from "../../../protocol/src/enrollment";
export interface StoredMaterial extends RememberedMaterial { token?: string; enrollment?: Enrollment }

export interface UnlockIdentity { vaultId: string; deviceId: string; databaseId: string; endpoint: string }
export interface LocalTextFiles { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; write(path: string, text: string): Promise<void> }
const secretHex = z.string().regex(/^[a-f0-9]{64}$/);
const materialSchema = z.strictObject({ format: z.literal(0), vaultId: z.string(), keyPackageFingerprint: secretHex,
  session: z.strictObject({ format: z.literal(0), vaultId: z.string(), content: secretHex, metadata: secretHex, paths: secretHex, local: secretHex, auth: secretHex }),
  token: z.string().min(32).max(128).optional(), enrollment: enrollmentSchema.optional(),
});
const identitySchema = z.strictObject({ vaultId: z.string(), deviceId: z.string(), databaseId: z.string(), endpoint: z.string() });
const envelopeSchema = z.strictObject({ format: z.literal(0), provider: z.string(), ciphertext: z.array(z.number().int().min(0).max(255)).min(1).max(8192) });
const secretSchema = z.strictObject({ format: z.literal(0), identity: identitySchema, material: materialSchema });
export class RememberedUnlock {
  constructor(private files: LocalTextFiles, private path: string, private identity: UnlockIdentity, private protector: SecretProtector) {}
  /** Presence for the UI only; never invoke native decryption or expose secret material. */
  async hasRecord(): Promise<boolean> {
    if (!await this.files.exists(this.path)) return false;
    const text = await this.files.read(this.path);
    try { return envelopeSchema.safeParse(JSON.parse(text)).success; }
    catch { return false; }
  }
  async save(material: StoredMaterial): Promise<void> {
    const validated = materialSchema.parse(material);
    if (validated.vaultId !== this.identity.vaultId || validated.session.vaultId !== this.identity.vaultId) throw new Error("WRONG_VAULT");
    const ciphertext = await this.protector.protect(JSON.stringify({ format: 0, identity: this.identity, material: validated }));
    const record = JSON.stringify({ format: 0, provider: this.protector.name, ciphertext: [...ciphertext] });
    await this.files.write(this.path, record);
    if (await this.files.read(this.path) !== record) throw new Error("UNLOCK_WRITE_INCOMPLETE");
  }
  async load(): Promise<StoredMaterial | null> {
    if (!await this.files.exists(this.path)) return null;
    const raw = JSON.parse(await this.files.read(this.path)) as unknown;
    if (z.strictObject({ format: z.literal(0), disabled: z.literal(true) }).safeParse(raw).success) return null;
    const envelope = envelopeSchema.parse(raw);
    if (envelope.provider !== this.protector.name) throw new Error("UNLOCK_PROVIDER_CHANGED");
    const restored = secretSchema.parse(JSON.parse(await this.protector.unprotect(new Uint8Array(envelope.ciphertext))));
    for (const field of ["vaultId", "deviceId", "databaseId", "endpoint"] as const) if (restored.identity[field] !== this.identity[field]) throw new Error("UNLOCK_IDENTITY_MISMATCH");
    return restored.material;
  }
  async clear(): Promise<void> {
    // A durable tombstone also prevents later auto-restore if the old ciphertext once existed.
    await this.files.write(this.path, JSON.stringify({ format: 0, disabled: true }));
  }
}
