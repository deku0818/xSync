import { canonical } from "../../../protocol/src/model";
import { enrollmentMessage, type Enrollment } from "../../../protocol/src/enrollment";
import { VaultCrypto, fingerprint, randomId } from "./crypto";
import { RemoteError, type Transport } from "./transport";
import type { RememberedUnlock, StoredMaterial } from "../desktop/remembered-unlock";

export interface EnrollmentContext {
  remote: Transport; deviceId: string; vaultId: string; name: string; key: string;
  previous?: StoredMaterial | null;
  pendingStore(vaultId: string): Promise<RememberedUnlock>;
  validate(material: StoredMaterial, epoch: string): Promise<void>;
  assertActive(): void;
  stage(step: "server" | "key" | "authorization" | "storage"): void;
}
/** Persists the exact signed request and credential before enrollment can commit remotely. */
export async function enrollConnection(input: EnrollmentContext): Promise<{ vaultId: string; material: StoredMaterial }> {
  const { remote } = input;
  input.assertActive();
  input.stage("server");
  const bootstrap = await remote.onboarding();
  if (input.vaultId && bootstrap.vaultId !== input.vaultId) throw new Error("HANDSHAKE_MISMATCH");
  input.stage("key");
  if (!input.key && !input.previous) throw new Error("CONNECTION_KEY_REQUIRED");
  const keys = input.key ? await VaultCrypto.unlock(bootstrap.vaultId, bootstrap.keyPackage, input.key) : await VaultCrypto.restore(bootstrap.vaultId, input.previous!.session);
  try {
    const anchor = await fingerprint(new TextEncoder().encode(canonical(bootstrap.keyPackage)));
    if (input.previous && input.previous.keyPackageFingerprint !== anchor) throw new Error("KEY_PACKAGE_CHANGED");
    if (keys.enrollmentPublicKey() !== bootstrap.publicKey) throw new Error("KEY_PACKAGE_CHANGED");
    const material: StoredMaterial = { format: 0, vaultId: bootstrap.vaultId, keyPackageFingerprint: anchor, session: keys.sessionMaterial(), token: input.previous?.token };
    await input.validate(material, bootstrap.epoch);
    input.assertActive();
    input.stage("authorization");
    if (material.token) {
      remote.setToken(material.token);
      try { await remote.handshake(); input.assertActive(); return { vaultId: bootstrap.vaultId, material }; }
      catch (error) { if (!(error instanceof RemoteError) || error.status !== 401) throw error; }
    }
    const pending = await input.pendingStore(bootstrap.vaultId);
    let draft = await pending.load();
    input.assertActive();
    if (draft) {
      if (!draft.token || !draft.enrollment || draft.keyPackageFingerprint !== anchor || draft.enrollment.deviceId !== input.deviceId || draft.enrollment.vaultId !== bootstrap.vaultId || draft.enrollment.epoch !== bootstrap.epoch) throw new Error("ENROLLMENT_PENDING_MISMATCH");
      if (await fingerprint(new TextEncoder().encode(draft.token)) !== draft.enrollment.tokenHash) throw new Error("ENROLLMENT_PENDING_MISMATCH");
      input.assertActive();
      try { await remote.enroll(draft.enrollment); }
      catch (error) {
        if (!(error instanceof RemoteError) || error.code !== "ENROLLMENT_EXPIRED") throw error;
        // The server retains successful receipts; EXPIRED means this request never committed.
        await pending.clear(); draft = null;
      }
    }
    if (!draft) {
      input.stage("authorization"); const challenge = await remote.challenge(); const token = randomId();
      input.assertActive();
      const unsigned: Omit<Enrollment,"signature"> = { format: 1, vaultId: bootstrap.vaultId, epoch: bootstrap.epoch, challenge, deviceId: input.deviceId, name: input.name, tokenHash: await fingerprint(new TextEncoder().encode(token)) };
      draft = { ...material, token, enrollment: { ...unsigned, signature: keys.signEnrollment(enrollmentMessage(unsigned)) } };
      input.assertActive();
      input.stage("storage"); await pending.save(draft);
      input.assertActive();
      input.stage("authorization"); await remote.enroll(draft.enrollment!);
    }
    input.assertActive();
    remote.setToken(draft.token!);
    return { vaultId: bootstrap.vaultId, material: { ...material, token: draft.token } };
  } finally { keys.close(); }
}
