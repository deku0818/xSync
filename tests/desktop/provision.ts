/// <reference types="node" />
import { mkdir, readFile, writeFile, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { VaultCrypto, randomId } from "../../plugin/src/sync/crypto";

const root = process.cwd();
const local = join(root, ".local/desktop");
const configPath = join(local, "server.json");
await mkdir(local, { recursive: true });
const TEST_PASSPHRASE = "obsidiansync-desktop-test-only";
let config: { dsn: string; listen: string; objectDir: string; vaultId: string; epoch: string; devices: { id: string; name: string; token: string }[]; keyPackage: unknown };
try { config = JSON.parse(await readFile(configPath, "utf8")) as typeof config; }
catch (error) {
  if ((error as { code?: string }).code !== "ENOENT") throw error;
  const env = await readFile(join(local, "postgres.env"), "utf8");
  const password = /^POSTGRES_PASSWORD=(.+)$/m.exec(env)?.[1]; if (!password) throw new Error("Missing Docker development credential");
  const vaultId = randomId(); const created = await VaultCrypto.create(vaultId, TEST_PASSPHRASE); created.crypto.close();
  config = { dsn: `postgres://syncdev:${encodeURIComponent(password)}@127.0.0.1:55438/obsidiansync?sslmode=disable`, listen: "127.0.0.1:8873", objectDir: join(local, "objects"), vaultId, epoch: randomId(),
    devices: [{ id: randomId(), name: "测试电脑 A", token: randomId() }, { id: randomId(), name: "测试电脑 B", token: randomId() }], keyPackage: created.keyPackage };
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}
const vaultRoot = join(root, "tests/desktop/vaults");
for (const [index, name] of ["ObsidianSync-电脑A", "ObsidianSync-电脑B"].entries()) {
  const vault = join(vaultRoot, name); const obsidian = join(vault, ".obsidian");
  const plugin = join(obsidian, "plugins/xsync");
  await mkdir(plugin, { recursive: true }); await mkdir(join(obsidian, "obsidian-sync-local"), { recursive: true });
  const putIfAbsent = async (path: string, content: string, mode = 0o600) => {
    try { await access(path); } catch { await writeFile(path, content, { mode, flag: "wx" }); }
  };
  await putIfAbsent(join(obsidian, "obsidian-sync-development.json"), JSON.stringify({ generatedBy: "ObsidianSync desktop test setup" }));
  await putIfAbsent(join(obsidian, "community-plugins.json"), JSON.stringify(["xsync"]));
  const device = config.devices[index]!;
  await putIfAbsent(join(obsidian, "obsidian-sync-local/device.json"), JSON.stringify({ endpoint: "http://127.0.0.1:8873", token: device.token, deviceId: device.id, deviceName: device.name, vaultId: config.vaultId, databaseId: randomId() }, null, 2));
  for (const file of ["main.js", "manifest.json", "styles.css", "LICENSE", "TEMPLATE-LICENSE.txt", "THIRD-PARTY-NOTICES.txt"]) await copyFile(join(root, "plugin/dist/xsync", file), join(plugin, file));
  await putIfAbsent(join(vault, "开始使用.md"), (await readFile(join(root, "tests/desktop/start-note.md"), "utf8")).replace("<TEST_PASSPHRASE>", TEST_PASSPHRASE), 0o644);
  await putIfAbsent(join(vault, "同步试验.md"), "# 同步试验\n\n共同版本 A。\n\n可以在两端修改这一段测试并发。\n", 0o644);
  console.log(`Prepared development vault: ${vault}`);
}
console.log("Docker PostgreSQL + two generated development vaults prepared; no production vault touched.");
