import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { goCommand } from "./go.mjs";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const local = ".local/desktop";
await mkdir(local, { recursive: true });
try { await access(`${local}/postgres.env`); } catch {
  await writeFile(`${local}/postgres.env`, `POSTGRES_USER=syncdev\nPOSTGRES_DB=obsidiansync\nPOSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: "inherit", ...options }); child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))); });
}
await run("docker", ["compose", "-f", "server/compose.dev.yaml", "up", "-d", "--wait"]);
await run(process.execPath, ["plugin/esbuild.sync.mjs"]);
await build({ entryPoints: ["tests/desktop/provision.ts"], bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", outfile: `${local}/provision.mjs` });
await run(process.execPath, [`${local}/provision.mjs`]);
// Native Go compiler only; PostgreSQL always runs in Docker.
await run(goCommand(), ["build", "-o", `${process.cwd()}/${local}/obsidiansync`, "./cmd/obsidiansync"], { cwd: "server" });
const config = JSON.parse(await readFile(`${local}/server.json`, "utf8"));
if (!config.dsn.includes("127.0.0.1:55438")) throw new Error("Expected dedicated Docker development database");
console.log("Ready. Run npm run desktop:start, then open tests/desktop/vaults in Obsidian.");
