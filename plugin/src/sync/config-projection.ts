import { canonical } from "../../../protocol/src/model";
import { isSelfPlugin } from "./plugin-identity";
import { COMMUNITY_PLUGINS_PATH, isSharedConfigPath } from "./config-path";
const encoder = new TextEncoder(); const decoder = new TextDecoder("utf-8", { fatal: true });
// Settings contain fractional values (zoom, coordinates, opacity). Protocol canonicalization
// deliberately accepts only safe integers; keep that stricter contract outside configuration JSON.
function canonicalConfig(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalConfig).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalConfig((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return canonical(value);
}
const deviceField = (key: string) => /^(?:.*(?:password|passphrase|privatekey|apikey|token|secret|credentials?|deviceid|installationid|sessionkey|encryptionkey|masterkey|vaultkey|synckey|recoverykey)|token|secret|secrets|credentials?|deviceid|installationid|sessionkey|encryptionkey)$/i.test(key.replace(/[^a-z0-9]/gi, ""));
function containsDeviceField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDeviceField);
  return !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => deviceField(key) || containsDeviceField(child));
}
const localEntry = (key: string, value: unknown) => deviceField(key) || Array.isArray(value) && containsDeviceField(value);
function project(value: unknown): unknown {
  if (Array.isArray(value)) { if (containsDeviceField(value)) throw new Error("CONFIG_ARRAY_HAS_DEVICE_FIELDS"); return value.map(project); }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key, child]) => !localEntry(key, child)).map(([key, child]) => [key, project(child)]));
  return value;
}
function merge(local: unknown, shared: unknown): unknown {
  if (Array.isArray(shared)) return shared.map((v, i) => merge(Array.isArray(local) ? local[i] : undefined, v));
  if (shared && typeof shared === "object") {
    const own = local && typeof local === "object" && !Array.isArray(local) ? local as Record<string, unknown> : {};
    return Object.fromEntries([...Object.entries(shared).filter(([key, value]) => !localEntry(key, value)).map(([key, value]) => [key, merge(own[key], value)]), ...Object.entries(own).filter(([key, value]) => localEntry(key, value))]);
  }
  return shared;
}
export function sharedConfig(path: string, bytes: Uint8Array): Uint8Array {
  if (!isSharedConfigPath(path) || !path.endsWith(".json")) return bytes;
  const value = JSON.parse(decoder.decode(bytes)) as unknown;
  const clean = path === COMMUNITY_PLUGINS_PATH && Array.isArray(value) ? value.filter(v => !isSelfPlugin(v)) : project(value);
  return encoder.encode(canonicalConfig(clean));
}
export function mergeConfig(path: string, local: Uint8Array | null, desired: Uint8Array): Uint8Array {
  if (!isSharedConfigPath(path) || !path.endsWith(".json")) return desired;
  const incoming = JSON.parse(decoder.decode(desired)) as unknown;
  if (path === COMMUNITY_PLUGINS_PATH && Array.isArray(incoming) && incoming.some(isSelfPlugin)) throw new Error("REMOTE_CONFIG_CONTAINS_DEVICE_FIELDS");
  if (canonicalConfig(project(incoming)) !== canonicalConfig(incoming)) throw new Error("REMOTE_CONFIG_CONTAINS_DEVICE_FIELDS");
  const own = local ? JSON.parse(decoder.decode(local)) as unknown : {};
  let result = merge(own, incoming);
  if (path === COMMUNITY_PLUGINS_PATH && Array.isArray(incoming) && Array.isArray(own) && own.some(isSelfPlugin)) {
    const shared: unknown[] = incoming; const local: unknown[] = own;
    result = [...shared.filter(v => !isSelfPlugin(v)), ...local.filter(isSelfPlugin)];
  }
  return encoder.encode(JSON.stringify(result, null, 2));
}
export function hasDeviceFields(path: string, local: Uint8Array): boolean {
  if (!path.endsWith(".json")) return false;
  const value = JSON.parse(decoder.decode(local)) as unknown;
  return canonicalConfig(value) !== canonicalConfig(JSON.parse(decoder.decode(sharedConfig(path, local))));
}
