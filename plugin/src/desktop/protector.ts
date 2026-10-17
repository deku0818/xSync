/** Loaded lazily by the desktop host. No Electron/Node dependency enters the sync core. */
import { Platform } from "obsidian";
declare const require: (id: string) => unknown;
export interface SecretProtector {
  readonly name: string;
  protect(plaintext: string): Promise<Uint8Array>;
  unprotect(ciphertext: Uint8Array): Promise<string>;
  /** Release only the native wrapping key named by this exact retired envelope. */
  forget?(ciphertext: Uint8Array, retainedCiphertexts?: readonly Uint8Array[]): Promise<void>;
}
interface SafeStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?: () => string;
  encryptString(plaintext: string): Uint8Array;
  decryptString(ciphertext: unknown): string;
}
interface DesktopModules { safeStorage: SafeStorage; bufferFrom(bytes: Uint8Array): unknown; platform: string }
function loadDesktopModules(): DesktopModules {
  if (Platform.isDesktop) {
    const remote = require("@electron/remote") as { safeStorage?: SafeStorage; process: { platform: string } };
    const nodeBuffer = require("node:buffer") as { Buffer: { from(bytes: Uint8Array): unknown } };
    if (!remote.safeStorage) throw new Error("DESKTOP_SECURE_STORAGE_UNAVAILABLE");
    return { safeStorage: remote.safeStorage, bufferFrom: (bytes: Uint8Array) => nodeBuffer.Buffer.from(bytes), platform: remote.process.platform };
  }
  throw new Error("DESKTOP_SECURE_STORAGE_REQUIRED");
}
export function desktopProtector(isDesktop: boolean, load?: () => DesktopModules): SecretProtector {
  if (!isDesktop) throw new Error("DESKTOP_SECURE_STORAGE_REQUIRED");
  const modules = load ? load() : loadDesktopModules();
  const storage = modules.safeStorage;
  const check = () => {
    if (!storage.isEncryptionAvailable()) throw new Error("DESKTOP_SECURE_STORAGE_UNAVAILABLE");
    if (modules.platform === "linux" && !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(storage.getSelectedStorageBackend?.() ?? "unknown")) throw new Error("INSECURE_STORAGE_BACKEND");
  };
  check();
  return {
    name: `electron-safeStorage:${modules.platform}`,
    async protect(plaintext) { check(); return new Uint8Array(storage.encryptString(plaintext)); },
    async unprotect(ciphertext) { check(); return storage.decryptString(modules.bufferFrom(ciphertext)); },
  };
}
