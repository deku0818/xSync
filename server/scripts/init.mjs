import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
await mkdir(".local/build", { recursive: true });
await build({ entryPoints: ["server/scripts/init.ts"], bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", outfile: ".local/build/init.mjs" });
const child = spawnSync(process.execPath, [".local/build/init.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
