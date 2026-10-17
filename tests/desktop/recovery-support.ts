/// <reference types="node" />
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { FilePort, RememberedMaterial } from "../../plugin/src/sync/engine";
import { SyncEngine } from "../../plugin/src/sync/engine";
import { SyncDB } from "../../plugin/src/sync/store";
import { Transport, type HTTP, type HTTPRequest } from "../../plugin/src/sync/transport";
import { VaultCrypto, bytesEqual, canonicalPath, randomId } from "../../plugin/src/sync/crypto";

export const RECOVERY_PASSPHRASE = "public-recovery-fixture-only";
export class RecoveryFiles implements FilePort {
  hook?: (operation: string, path: string) => Promise<void>;
  writes = 0;
  constructor(readonly root: string) {}
  path(path: string): string { canonicalPath(path); return join(this.root, path); }
  async list(): Promise<string[]> {
    await this.hook?.("list", "");
    const walk = async (root: string, prefix = ""): Promise<string[]> => {
      const files: string[] = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = prefix + entry.name;
        if (entry.isDirectory()) files.push(...await walk(join(root, entry.name), path + "/")); else if (entry.isFile()) files.push(path); else throw new Error("UNSUPPORTED_TEST_ENTRY");
      }
      return files;
    };
    return walk(this.root);
  }
  async read(path: string): Promise<Uint8Array | null> {
    await this.hook?.("read", path);
    try { return new Uint8Array(await readFile(this.path(path))); }
    catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; }
  }
  async stat(path: string): Promise<{ size: number } | null> { const b = await this.read(path); return b ? { size: b.length } : null; }
  async write(path: string, desired: Uint8Array, expected: Uint8Array | null): Promise<void> {
    await this.hook?.("write", path);
    const current = await this.read(path);
    if (expected === null ? current !== null : current === null || !bytesEqual(expected, current)) throw new Error("LOCAL_CHANGED_DURING_APPLY");
    await mkdir(join(this.path(path), ".."), { recursive: true }); await writeFile(this.path(path), desired); this.writes++;
  }
  async rename(from: string, to: string, expected: Uint8Array): Promise<void> {
    await this.hook?.("rename", from);
    const current = await this.read(from);
    if (!current || !bytesEqual(current, expected) || await this.read(to)) throw new Error("LOCAL_CHANGED_DURING_RENAME");
    await mkdir(join(this.path(to), ".."), { recursive: true }); await rename(this.path(from), this.path(to));
  }
  async remove(path: string, expected: Uint8Array): Promise<void> {
    await this.hook?.("remove", path);
    const current = await this.read(path);
    if (!current || !bytesEqual(current, expected)) throw new Error("LOCAL_CHANGED_DURING_DELETE");
    await unlink(this.path(path));
  }
  async stageWrite(id: string, bytes: Uint8Array): Promise<void> {
    await this.hook?.("stageWrite", id);
    if (!/^(?:c_)?[a-f0-9]{64}$/.test(id)) throw new Error("INVALID_STAGE_ID");
    const root = join(this.root, ".stage"); await mkdir(root, { recursive: true });
    try { await writeFile(join(root, id), bytes, { flag: "wx" }); }
    catch (e) { if ((e as { code?: string }).code !== "EEXIST" || !bytesEqual(new Uint8Array(await readFile(join(root, id))), bytes)) throw e; }
  }
  async stageRead(id: string): Promise<Uint8Array> { await this.hook?.("stageRead", id); return new Uint8Array(await readFile(join(this.root, ".stage", id))); }
  async stageList(): Promise<string[]> {
    await this.hook?.("stageList", "");
    try { return (await readdir(join(this.root, ".stage"))).filter(id => /^(?:c_)?[a-f0-9]{64}$/.test(id)); }
    catch (e) { if ((e as { code?: string }).code === "ENOENT") return []; throw e; }
  }
  async stageRemove(id: string): Promise<void> {
    if (!/^(?:c_)?[a-f0-9]{64}$/.test(id)) throw new Error("INVALID_STAGE_ID");
    await this.hook?.("stageRemove", id);
    await rm(join(this.root, ".stage", id), { force: true });
  }
  async edit(path: string, text: string): Promise<void> { await mkdir(join(this.path(path), ".."), { recursive: true }); await writeFile(this.path(path), text); }
  async text(path: string): Promise<string | null> { const b = await this.read(path); return b === null ? null : new TextDecoder().decode(b); }
}
export const recoveryHTTP: HTTP = async request => {
  const r = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body?.slice().buffer });
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), bytes: new Uint8Array(await r.arrayBuffer()) };
};
export interface RecoveryClient { engine: SyncEngine; db: SyncDB; files: RecoveryFiles; material: RememberedMaterial; databaseName: string }
export class RecoveryFixture {
  root = "";
  endpoint = "";
  schema = `e2e_${randomId().slice(0, 16)}`;
  config!: { dsn: string; vaultId: string; epoch: string; devices: { id: string; name: string; token: string }[] };
  server?: ChildProcess;
  clients: RecoveryClient[] = [];
  httpHook?: (request: HTTPRequest, next: () => ReturnType<HTTP>) => ReturnType<HTTP>;
  private resumed = false;
  async open(onboarding = false, metadataMode?: "full", deviceCount = 2): Promise<void> {
    await mkdir(".local", { recursive: true }); this.root = await mkdtemp(join(process.cwd(), ".local/recovery-"));
    const base = JSON.parse(await readFile(".local/desktop/server.json", "utf8"));
    if (!base.dsn.includes("127.0.0.1:55438")) throw new Error("DEDICATED_DOCKER_DATABASE_REQUIRED");
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve())); this.endpoint = `http://127.0.0.1:${port}`;
    const vaultId = randomId(); const created = await VaultCrypto.create(vaultId, RECOVERY_PASSPHRASE);
    const enrollmentPublicKey = onboarding ? created.crypto.enrollmentPublicKey() : undefined; created.crypto.close();
    this.config = { ...base, ...(metadataMode ? { metadataMode } : {}), vaultId, epoch: randomId(), devices: onboarding ? [] : Array.from({ length: deviceCount }, (_, i) => ({ id: randomId(), name: `Recovery ${i}`, token: randomId() })), keyPackage: created.keyPackage, enrollmentPublicKey, listen: `127.0.0.1:${port}`, cleanupMode: "off", objectDir: join(this.root, "objects") };
    await writeFile(join(this.root, "server.json"), JSON.stringify(this.config), { mode: 0o600 });
    await this.startServer(false);
  }
  transport(index: number): Transport {
    return new Transport(this.endpoint, this.config.devices[index]!.token, request => this.httpHook ? this.httpHook(request, () => recoveryHTTP(request)) : recoveryHTTP(request));
  }
  async startServer(resume: boolean): Promise<void> {
    const args = ["--config", join(this.root, "server.json"), "--test-schema", this.schema];
    if (resume) { args.push("--resume-test-schema"); this.resumed = true; }
    this.server = spawn(".local/desktop/obsidiansync", args, { stdio: ["ignore", "ignore", "pipe"] });
    let logs = ""; this.server.stderr?.on("data", b => { logs += String(b); });
    const deadline = Date.now() + 10000;
    for (;;) {
      if (this.server.exitCode !== null) throw new Error(`Recovery service failed: ${logs}`);
      try { if (this.config.devices.length) await this.transport(0).handshake(); else await new Transport(this.endpoint,"",recoveryHTTP).onboarding(); return; } catch { if (Date.now() >= deadline) throw new Error("RECOVERY_SERVICE_START_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 25)); }
    }
  }
  async client(index: number): Promise<RecoveryClient> {
    const files = new RecoveryFiles(join(this.root, `files-${index}`)); await mkdir(files.root, { recursive: true });
    const db = new SyncDB(`recovery-${randomId()}`); await db.open();
    const d = this.config.devices[index]!; const engine = new SyncEngine(db, this.transport(index), files, d.id, this.config.vaultId);
    await engine.unlock(RECOVERY_PASSPHRASE);
    const client = { engine, db, files, material: engine.rememberedMaterial(), databaseName: db.name }; this.clients[index] = client;
    return client;
  }
  async reopen(index: number): Promise<RecoveryClient> {
    const old = this.clients[index]!; old.engine.lock(); old.db.close();
    const db = new SyncDB(old.databaseName); await db.open(); const d = this.config.devices[index]!;
    const engine = new SyncEngine(db, this.transport(index), old.files, d.id, this.config.vaultId); await engine.restoreRemembered(old.material);
    return this.clients[index] = { ...old, db, engine };
  }
  async killServer(): Promise<void> {
    if (!this.server || this.server.exitCode !== null || this.server.signalCode !== null) return;
    const exited = new Promise(resolve => this.server!.once("exit", resolve)); this.server.kill("SIGKILL"); await exited;
  }
  async sql(statement: string): Promise<void> {
    if (!/^e2e_[a-f0-9]{16}$/.test(this.schema)) throw new Error("INVALID_TEST_SCHEMA");
    const child = spawn("docker", ["compose", "-f", "server/compose.dev.yaml", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "syncdev", "-d", "obsidiansync", "-c", statement], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("TEST_DATABASE_OPERATION_FAILED"))); });
  }
  async collect(fault?: string): Promise<void> {
    const args = ["--config", join(this.root, "server.json"), "--test-schema", this.schema, "--resume-test-schema", "--cleanup-once"];
    if (fault) args.push("--test-maintenance-fault", fault);
    const child = spawn(".local/desktop/obsidiansync", args, { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => fault ? signal === "SIGKILL" ? resolve() : reject(new Error("MAINTENANCE_FAULT_NOT_REACHED")) : code === 0 ? resolve() : reject(new Error("MAINTENANCE_FAILED")));
    });
  }
  async collectExpired(): Promise<void> {
    await this.collect();
    await this.sql(`UPDATE ${this.schema}.objects SET unreferenced_at=clock_timestamp()-interval '2 hours' WHERE state='candidate'`);
    await this.collect();
  }
  async retireLogs(): Promise<void> {
    await this.sql(`UPDATE ${this.schema}.changes SET created_at=clock_timestamp()-interval '8 days'`);
    await this.collect();
  }
  async expireLog(boundary: number): Promise<void> {
    if (!Number.isSafeInteger(boundary) || boundary < 0) throw new Error("INVALID_TEST_BOUNDARY");
    await this.sql(`UPDATE ${this.schema}.vaults SET min_seq=${boundary}`);
  }
  async close(): Promise<void> {
    for (const c of this.clients) if (c) { c.engine.lock(); await c.db.delete(); }
    if (this.server && this.server.exitCode === null && this.server.signalCode === null) {
      const exited = new Promise(resolve => this.server!.once("exit", resolve)); this.server.kill("SIGTERM"); await exited;
    }
    if (this.resumed) {
      await this.sql(`DROP SCHEMA ${this.schema} CASCADE`);
    }
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}
