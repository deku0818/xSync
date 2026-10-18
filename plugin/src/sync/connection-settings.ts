import { z } from "zod";
import { normalizeEndpoint } from "./transport";
import { defaultRules, validateRules, rulesSchema, type SyncRules } from "./policy";
import { pendingProfileSchema, type PendingProfile } from "./client-profile";
import type { LanguagePreference } from "../i18n";
const language = z.enum(["auto", "zh", "en"]).default("auto");
const fields = { language, autoSync: z.boolean(), endpoint: z.string(), record: z.string().regex(/^connection-[a-f0-9]{64}\.json$/) };
const savedConnection = z.strictObject({ format: z.literal(2), ...fields });
const currentConnection = z.strictObject({ format: z.literal(3), ...fields, record: z.union([fields.record, z.literal("desktop-unlock.json")]), restoreAllowed: z.boolean().default(true), clientName: z.string().max(128), rules: rulesSchema, profileRevision: z.number().int().nonnegative(), profileDirty: z.boolean(), profilePending: pendingProfileSchema.optional() });
const ordinaryConnection = currentConnection.extend({ format: z.literal(4), vaultId: z.string().regex(/^(?:[a-zA-Z0-9_-]{1,128})?$/), accessRecord: z.string().regex(/^access-[a-f0-9]{64}\.json$/).optional(), userId: z.string().regex(/^[a-f0-9]{64}$/).optional(), vaultName: z.string().max(80).optional() });
export interface ConnectionSettings { language: LanguagePreference; accessRecord?: string; userId?: string; vaultName?: string; endpoint: string; vaultId?: string; autoSync: boolean; record: string; restoreAllowed: boolean; clientName?: string; rules: SyncRules; profileRevision?: number; profileDirty: boolean; profilePending?: PendingProfile }
export function connectionSettings(input: unknown, defaultEndpoint: string, developmentEndpoint?: string): ConnectionSettings {
  const format = input && typeof input === "object" && "format" in input ? input.format : undefined;
  if (format === 3 || format === 4) {
    const s = (format === 4 ? ordinaryConnection : currentConnection).parse(input);
    if (s.format === 4 && !!s.endpoint !== !!(s.vaultId || s.accessRecord)) throw new Error("INVALID_CONNECTION_IDENTITY");
    const endpoint = s.format === 4 && !s.endpoint ? "" : normalizeEndpoint(s.endpoint, developmentEndpoint);
    return { ...s, endpoint, rules: validateRules(s.rules) };
  }
  if (format === 2) {
    const s = savedConnection.parse(input); return { language: s.language, endpoint: normalizeEndpoint(s.endpoint, developmentEndpoint), autoSync: s.autoSync, record: s.record, restoreAllowed: true, rules: defaultRules(), profileDirty: true };
  }
  const s = z.object({ language, format: z.literal(1).optional(), autoSync: z.boolean().optional(), rememberDevice: z.boolean().optional(), manualLocked: z.boolean().optional() }).parse(input ?? {});
  return { language: s.language, endpoint: defaultEndpoint ? normalizeEndpoint(defaultEndpoint, developmentEndpoint) : "", autoSync: s.format === 1 ? s.autoSync !== false : true, record: "desktop-unlock.json", restoreAllowed: s.rememberDevice !== false && s.manualLocked !== true, rules: defaultRules(), profileDirty: true };
}
