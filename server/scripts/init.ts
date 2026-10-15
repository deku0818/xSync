import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { VaultCrypto, randomId } from "../../plugin/src/sync/crypto";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) throw new Error("Usage: npm run server:init -- --out <new-private-directory>");
const directory = resolve(args[1]);
// A local owner creates the vault identity. No network request and no plaintext key in the server bundle.
await mkdir(directory, { mode: 0o700 });
const key = randomId(); const vaultId = randomId();
const created = await VaultCrypto.create(vaultId, key);
try {
  await writeFile(join(directory,"sync-key.txt"), `${key}\n`, { mode: 0o600, flag: "wx" });
  await writeFile(join(directory,"server.json"), JSON.stringify({ listen: "127.0.0.1:8873", objectDir: "./data/objects", vaultId, epoch: randomId(), devices: [], keyPackage: created.keyPackage, enrollmentPublicKey: created.crypto.enrollmentPublicKey() },null,2)+"\n", { mode: 0o600, flag: "wx" });
  console.log(`Server bundle: ${join(directory,"server.json")}\nPrivate sync key (keep on your own device): ${join(directory,"sync-key.txt")}\nCopy only server.json to the server. Configure XSYNC_DATABASE_URL separately.`);
} finally { created.crypto.close(); }
