import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultCrypto } from "../../plugin/src/sync/crypto";

it("creates an owner-local key and a server bundle without plaintext credentials, and refuses to overwrite an existing identity", async () => {
  const root = await mkdtemp(join(tmpdir(),"xsync-init-")); const out = join(root,"owner");
  async function run() {
    const child = spawn(process.execPath,["server/scripts/init.mjs","--out",out],{stdio:["ignore","pipe","pipe"]});
    let output = ""; child.stdout.on("data",b=>{output+=String(b);}); child.stderr.on("data",b=>{output+=String(b);});
    const code = await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);}); return {code,output};
  }
  try {
    const first = await run(); expect(first.code).toBe(0);
    const key = (await readFile(join(out,"sync-key.txt"),"utf8")).trim(); expect(key).toMatch(/^[a-f0-9]{64}$/);
    const raw = await readFile(join(out,"server.json"),"utf8"); const bundle = JSON.parse(raw);
    expect(raw).not.toContain(key); expect(first.output).not.toContain(key); expect(bundle.devices).toEqual([]); expect(bundle.dsn).toBeUndefined();
    const crypto = await VaultCrypto.unlock(bundle.vaultId,bundle.keyPackage,key);
    try { expect(crypto.enrollmentPublicKey()).toBe(bundle.enrollmentPublicKey); } finally { crypto.close(); }
    if (process.platform !== "win32") { expect((await stat(out)).mode & 0o777).toBe(0o700); for (const file of ["server.json","sync-key.txt"]) expect((await stat(join(out,file))).mode & 0o777).toBe(0o600); }
    expect((await run()).code).not.toBe(0); expect(await readFile(join(out,"server.json"),"utf8")).toBe(raw);
  } finally { await rm(root,{recursive:true,force:true}); }
},10000);
