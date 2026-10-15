import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Explicit override, project-local compiler, then the Go installation on PATH.
export function goCommand() {
  const override = process.env.OBSIDIAN_SYNC_GO;
  if (override) return !isAbsolute(override) && /[/\\]/.test(override) ? resolve(root, override) : override;
  const local = resolve(root, ".local/toolchains/go/bin", process.platform === "win32" ? "go.exe" : "go");
  return existsSync(local) ? local : "go";
}
