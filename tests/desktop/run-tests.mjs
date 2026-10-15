import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { goCommand } from "./go.mjs";
process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", ...options }); child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
const go = goCommand();
await run(go, ["build", "-o", `${process.cwd()}/.local/desktop/obsidiansync`, "./cmd/obsidiansync"], { cwd: "server" });
await run(go, ["test", "-count=1", "-race", "-v", "./..."], { cwd: "server", env: { ...process.env, OBSIDIAN_SYNC_TEST_CONFIG: `${process.cwd()}/.local/desktop/server.json` } });
await run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/desktop/engine.integration.test.ts", "tests/desktop/recovery.integration.test.ts", "tests/desktop/enrollment.integration.test.ts"], { env: { ...process.env, OBSIDIAN_SYNC_DESKTOP_TEST: "1" } });
const chrome = process.env.OBSIDIAN_SYNC_CHROME ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
if (chrome && existsSync(chrome)) {
  await run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/desktop/recovery-browser.integration.test.ts"], { env: { ...process.env, OBSIDIAN_SYNC_BROWSER_TEST: "1", OBSIDIAN_SYNC_CHROME: chrome } });
} else if (process.env.OBSIDIAN_SYNC_CHROME) {
  throw new Error("OBSIDIAN_SYNC_CHROME does not name an installed executable");
} else {
  console.log("Native IndexedDB/SIGKILL suite not run: set OBSIDIAN_SYNC_CHROME to an installed Chrome/Chromium executable.");
}
