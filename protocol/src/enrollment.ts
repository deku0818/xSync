import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const onboardingSchema = z.strictObject({ format: z.literal(1), vaultId: id, epoch: id, keyPackage: z.unknown(), publicKey: hex });
export const challengeSchema = z.strictObject({ id: hex, nonce: hex });
export const enrollmentSchema = z.strictObject({ format: z.literal(1), vaultId: id, epoch: id,
  challenge: challengeSchema, deviceId: id, name: z.string().min(1).max(128), tokenHash: hex,
  signature: z.string().regex(/^[a-f0-9]{128}$/) });
export type Enrollment = z.infer<typeof enrollmentSchema>;
/** Length-prefixed UTF-8 avoids JSON escaping / Unicode canonicalization differences across runtimes. */
export function enrollmentMessage(input: Omit<Enrollment, "signature">): Uint8Array {
  const fields = ["xsync:device-enrollment-v1", input.vaultId, input.epoch, input.challenge.id, input.challenge.nonce, input.deviceId, input.name, input.tokenHash];
  const encoded = fields.map(value => new TextEncoder().encode(value));
  const result = new Uint8Array(encoded.reduce((n, value) => n + 4 + value.length, 0));
  let offset = 0;
  for (const value of encoded) { new DataView(result.buffer).setUint32(offset, value.length); offset += 4; result.set(value, offset); offset += value.length; }
  return result;
}
