import { z } from "zod";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const deviceProfileSchema = z.strictObject({ id, name: z.string().min(1).max(128), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), ciphertext: z.string().max(262144).optional(), reportedAt: z.string().max(64).optional(), revoked: z.boolean().optional() });
export type DeviceProfile = z.infer<typeof deviceProfileSchema>;
export const devicesSchema = z.strictObject({ devices: z.array(deviceProfileSchema).max(10000) });
export function clientName(name: string): string { const value = name.trim(); if (!value || [...value].length > 40 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("请输入 1–40 个字符的客户端名称"); return value; }
