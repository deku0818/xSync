import { z } from "zod";
import { rulesSchema, validateRules, type SyncRules } from "./policy";
export const profileSchema = z.strictObject({ format: z.literal(1), name: z.string().min(1).max(128), platform: z.string().max(64), pluginVersion: z.string().max(32), autoSync: z.boolean(), rules: rulesSchema });
export type ClientConfiguration = z.infer<typeof profileSchema>;
export interface ClientView { id: string; name: string; revision: number; reportedAt?: string; revoked?: boolean; configuration?: ClientConfiguration; error?: string }
export const pendingProfileSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), name: z.string().min(1).max(128), ciphertext: z.string().max(262144) });
export type PendingProfile = z.infer<typeof pendingProfileSchema>;
export function decodeProfile(value: unknown, name: string): ClientConfiguration { const profile = profileSchema.parse(value); if (profile.name !== name) throw new Error("PROFILE_NAME_MISMATCH"); profile.rules = validateRules(profile.rules); return profile; }
export function sameRules(a: SyncRules, b: SyncRules): boolean { return JSON.stringify(a) === JSON.stringify(b); }
