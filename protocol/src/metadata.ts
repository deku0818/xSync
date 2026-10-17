import { z } from "zod";
import { receiptSchema, revisionSchema, baseProofSchema } from "./wire";
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export { baseProofSchema } from "./wire";
export const baseAnchorSchema = z.strictObject({ revision: revisionSchema, proof: baseProofSchema });
export const requestStreamSchema = z.strictObject({ id: opaque, maximum: number, retired: number });
export const trackedResultSchema = z.strictObject({ receipt: receiptSchema, bases: z.array(baseAnchorSchema).max(2000) });
export interface RequestCoordinate { stream: string; number: number }
export function derivedID(coordinate: RequestCoordinate, role: "r" | "l" | "rc" | "lc", index = 0): string { return `m_${coordinate.stream}_${coordinate.number}_${role}_${index}`; }
export function derivedOperation(coordinate: RequestCoordinate): string { return `q_${coordinate.stream}_${coordinate.number}`; }
export type BaseProof = z.infer<typeof baseProofSchema>;
export type BaseAnchor = z.infer<typeof baseAnchorSchema>;
export interface RequestAck extends RequestCoordinate { opId: string; receipt: z.infer<typeof receiptSchema> }
