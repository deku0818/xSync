import { z } from "zod";

export const CONTINUITY_CAPABILITY = "device-continuity-v1";
export const continuitySchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/) });
export const migrationStateSchema = z.strictObject({ legacy: z.boolean(), objects: z.boolean() });
