import { z } from "zod";
import { normalizeEndpoint } from "./transport";
import { defaultRules, validateRules, rulesSchema, type SyncRules } from "./policy";
import { pendingProfileSchema, type PendingProfile } from "./client-profile";
const fields = { autoSync: z.boolean(), endpoint: z.string(), record: z.string().regex(/^connection-[a-f0-9]{64}\.json$/) };
const savedConnection = z.strictObject({ format: z.literal(2), ...fields });
const currentConnection = z.strictObject({ format: z.literal(3), ...fields, record: z.union([fields.record, z.literal("desktop-unlock.json")]), restoreAllowed: z.boolean().default(true), clientName: z.string().max(128), rules: rulesSchema, profileRevision: z.number().int().nonnegative(), profileDirty: z.boolean(), profilePending: pendingProfileSchema.optional() });
export interface ConnectionSettings { endpoint: string; autoSync: boolean; record: string; restoreAllowed: boolean; clientName?: string; rules: SyncRules; profileRevision?: number; profileDirty: boolean; profilePending?: PendingProfile }
export function connectionSettings(input: unknown, defaultEndpoint: string): ConnectionSettings {
  if (input && typeof input === "object" && "format" in input && input.format === 3) {
    const s = currentConnection.parse(input); return { ...s, endpoint: normalizeEndpoint(s.endpoint), restoreAllowed: s.restoreAllowed, rules: validateRules(s.rules) };
  }
  if (input && typeof input === "object" && "format" in input && input.format === 2) {
    const s = savedConnection.parse(input); return { endpoint: normalizeEndpoint(s.endpoint), autoSync: s.autoSync, record: s.record, restoreAllowed: true, rules: defaultRules(), profileDirty: true };
  }
  const s = z.object({ format: z.literal(1).optional(), autoSync: z.boolean().optional(), rememberDevice: z.boolean().optional(), manualLocked: z.boolean().optional() }).parse(input ?? {});
  return { endpoint: normalizeEndpoint(defaultEndpoint), autoSync: s.format === 1 ? s.autoSync !== false : true, record: "desktop-unlock.json", restoreAllowed: s.rememberDevice !== false && s.manualLocked !== true, rules: defaultRules(), profileDirty: true };
}
