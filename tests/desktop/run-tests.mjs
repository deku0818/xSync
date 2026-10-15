import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { goCommand } from "./go.mjs";
process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", ...options }); child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
const go = goCommand();
await run(go, ["build", "-o", `${process.cwd()}/.local/desktop/obsidiansync`, "./cmd/obsidiansync"], { cwd: "server" });
await run(go, ["test", "-count=1", "-race", "-v", "./..."], { cwd: "server", env: { ...process.env, OBSIDIAN_SYNC_TEST_CONFIG: `${process.cwd()}/.local/desktop/server.json` } });
await run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/desktop/engine.integration.test.ts"], { env: { ...process.env, OBSIDIAN_SYNC_DESKTOP_TEST: "1" } });
