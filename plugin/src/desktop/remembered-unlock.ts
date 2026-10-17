import { z } from "zod";

import { enrollmentSchema, type Enrollment } from "../../../protocol/src/enrollment.js";
import { sessionSchema } from "../sync/crypto.js";
import type { RememberedMaterial } from "../sync/engine.js";
import type { SecretProtector } from "./protector.js";
export interface StoredMaterial extends RememberedMaterial { token?: string; enrollment?: Enrollment }

export interface UnlockIdentity { vaultId: string; deviceId: string; databaseId: string; endpoint: string }
export interface LocalTextFiles { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; write(path: string, text: string): Promise<void>; remove?(path: string): Promise<void> }
const secretHex = z.string().regex(/^[a-f0-9]{64}$/);
const materialSchema = z.strictObject({ format: z.literal(0), vaultId: z.string(), keyPackageFingerprint: secretHex,
  session: sessionSchema,
  token: z.string().min(32).max(128).optional(), enrollment: enrollmentSchema.optional(),
});
const identitySchema = z.strictObject({ vaultId: z.string(), deviceId: z.string(), databaseId: z.string(), endpoint: z.string() });
const envelopeSchema = z.strictObject({ format: z.literal(0), provider: z.string(), ciphertext: z.array(z.number().int().min(0).max(255)).min(1).max(8192) });
const secretSchema = z.strictObject({ format: z.literal(0), identity: identitySchema, material: materialSchema });
const disabledSchema = z.strictObject({ format: z.literal(0), disabled: z.literal(true) });
const retirementSchema = z.strictObject({ format: z.literal(0), identity: identitySchema, record: z.string().max(65536) });
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
    if (disabledSchema.safeParse(raw).success) return null;
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
  private async readRetirement(): Promise<z.infer<typeof retirementSchema> | undefined> {
    const journal = `${this.path}.retiring`;
    if (!await this.files.exists(journal)) return;
    const text = await this.files.read(journal);
    try {
      const parsed = retirementSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch { /* A torn new journal has not authorized native key deletion. The original is intact. */ }
  }
  async retirementIdentity(): Promise<UnlockIdentity | null> {
    return (await this.readRetirement())?.identity ?? null;
  }
  /** Persist before replacing the settings pointer; preparation never removes a file or native key. */
  async prepareRetirement(): Promise<void> {
    if (!this.files.remove || await this.readRetirement() || !await this.files.exists(this.path)) return;
    // Keep the opaque original even if it cannot currently be opened. Deletion validates it below.
    const retirement = retirementSchema.parse({ format: 0, identity: this.identity, record: await this.files.read(this.path) });
    const encoded = JSON.stringify(retirement), journal = `${this.path}.retiring`;
    await this.files.write(journal, encoded);
    if (await this.files.read(journal) !== encoded) throw new Error("UNLOCK_WRITE_INCOMPLETE");
  }
  /** Caller has durably installed another record; this path is no longer a recovery pointer. */
  async retire(active?: RememberedUnlock): Promise<void> {
    if (active?.path === this.path) return;
    if (!this.files.remove) return;
    const journal = `${this.path}.retiring`;
    await this.prepareRetirement();
    const retirement = await this.readRetirement();
    if (!retirement) return;
    for (const field of ["vaultId", "deviceId", "databaseId", "endpoint"] as const) {
      if (retirement.identity[field] !== this.identity[field]) throw new Error("UNLOCK_IDENTITY_MISMATCH");
    }
    if (active) {
      for (const field of ["vaultId", "deviceId", "databaseId"] as const) {
        if (retirement.identity[field] !== active.identity[field]) throw new Error("UNLOCK_IDENTITY_MISMATCH");
      }
    }
    const raw: unknown = JSON.parse(retirement.record);
    if (!disabledSchema.safeParse(raw).success) {
      const envelope = envelopeSchema.parse(raw);
      if (envelope.provider !== this.protector.name) throw new Error("UNLOCK_PROVIDER_CHANGED");
      const retained: Uint8Array[] = [];
      if (active) {
        const current = envelopeSchema.parse(JSON.parse(await active.files.read(active.path)));
        if (current.provider === envelope.provider) retained.push(new Uint8Array(current.ciphertext));
      }
      if (await this.files.exists(this.path)) {
        const text = await this.files.read(this.path);
        if (text !== retirement.record) {
          const current = envelopeSchema.parse(JSON.parse(text));
          if (current.provider === envelope.provider) retained.push(new Uint8Array(current.ciphertext));
        }
      }
      await this.protector.forget?.(new Uint8Array(envelope.ciphertext), retained);
    }
    if (await this.files.exists(this.path) && await this.files.read(this.path) === retirement.record) await this.files.remove(this.path);
    await this.files.remove(journal);
  }
}
