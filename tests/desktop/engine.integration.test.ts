/// <reference types="node" />
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, unlink, rm } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import type { App } from "obsidian";
import { ObsidianVaultPort } from "../../plugin/src/sync/vault-port";
import { SyncPolicy, defaultRules } from "../../plugin/src/sync/policy";
vi.mock("obsidian", () => ({ TFile: class {} }));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { SyncEngine, type FilePort } from "../../plugin/src/sync/engine";
import { SyncDB } from "../../plugin/src/sync/store";
import { Transport, type HTTP } from "../../plugin/src/sync/transport";
import { VaultCrypto, bytesEqual, canonicalPath, randomId } from "../../plugin/src/sync/crypto";

const enc = new TextEncoder(); const dec = new TextDecoder();
class DiskVault implements FilePort {
  constructor(readonly root: string) {}
  private path(path: string): string { canonicalPath(path); return join(this.root, path); }
  async list(): Promise<string[]> {
    const walk = async (dir: string, prefix = ""): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue; const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...await walk(join(dir, e.name), path)); else if (e.isFile()) out.push(path); else throw new Error("UNSUPPORTED_ENTRY");
      } return out;
    };
    return walk(this.root);
  }
  async read(path: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(await readFile(this.path(path))); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; }
  }
  async write(path: string, desired: Uint8Array, expected: Uint8Array | null): Promise<void> {
    const current = await this.read(path);
    if (expected === null ? current !== null : current === null || !bytesEqual(current, expected)) throw new Error("LOCAL_CHANGED_DURING_APPLY");
    const file = this.path(path); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, desired, { flag: expected === null ? "wx" : "w" });
  }
  async rename(from: string, to: string, expected: Uint8Array): Promise<void> {
    const current = await this.read(from); if (!current || !bytesEqual(current, expected) || await this.read(to)) throw new Error("RENAME_GUARD");
    await rename(this.path(from), this.path(to));
  }
  async remove(path: string, expected: Uint8Array): Promise<void> { const current = await this.read(path); if (!current || !bytesEqual(current, expected)) throw new Error("DELETE_GUARD"); await unlink(this.path(path)); }
  async stageWrite(id: string, ciphertext: Uint8Array): Promise<void> {
    if (!/^(?:c_)?[a-f0-9]{64}$/.test(id)) throw new Error("INVALID_STAGE_ID");
    await mkdir(join(this.root, ".local"), { recursive: true }); const path = join(this.root, ".local", id);
    try { await writeFile(path, ciphertext, { flag: "wx" }); } catch (e) { if ((e as { code?: string }).code !== "EEXIST" || !bytesEqual(new Uint8Array(await readFile(path)), ciphertext)) throw e; }
  }
  async stageRead(id: string): Promise<Uint8Array> { return new Uint8Array(await readFile(join(this.root, ".local", id))); }
  async stageList(): Promise<string[]> {
    try { return (await readdir(join(this.root, ".local"))).filter(id => /^(?:c_)?[a-f0-9]{64}$/.test(id)); }
    catch (e) { if ((e as { code?: string }).code === "ENOENT") return []; throw e; }
  }
  async stageRemove(id: string): Promise<void> {
    if (!/^(?:c_)?[a-f0-9]{64}$/.test(id)) throw new Error("INVALID_STAGE_ID");
    await rm(join(this.root, ".local", id), { force: true });
  }
  async edit(path: string, text: string): Promise<void> { await writeFile(this.path(path), text); }
  async text(path: string): Promise<string | null> { const b = await this.read(path); return b === null ? null : new TextDecoder().decode(b); }
}
const nativeHTTP: HTTP = async r => {
  const response = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body?.slice().buffer });
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), bytes: new Uint8Array(await response.arrayBuffer()) };
};
describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("two clients + actual files + Go HTTP + Docker PostgreSQL (fake IndexedDB)", () => {
  let root: string; let server: ChildProcess; let config: { vaultId: string; devices: { id: string; name: string; token: string }[] };
  let endpoint: string; let a: SyncEngine; let b: SyncEngine; let va: DiskVault; let vb: DiskVault;
  const dbs: SyncDB[] = []; let dropReceipt = false; let blockUploads = false;
  let raceResolution: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "obsidiansync-e2e-"));
    const base = JSON.parse(await readFile(".local/desktop/server.json", "utf8")) as Record<string, unknown>;
    const vaultId = randomId(); const keys = await VaultCrypto.create(vaultId, "public-e2e-test-passphrase"); keys.crypto.close();
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve())); endpoint = `http://127.0.0.1:${port}`;
    config = { vaultId, devices: [{ id: randomId(), name: "测试电脑 A", token: randomId() }, { id: randomId(), name: "测试电脑 B", token: randomId() }, { id: randomId(), name: "配置测试 A", token: randomId() }, { id: randomId(), name: "配置测试 B", token: randomId() }] };
    const cfg = { ...base, ...config, epoch: randomId(), keyPackage: keys.keyPackage, objectDir: join(root, "objects"), listen: `127.0.0.1:${port}` };
    const path = join(root, "server.json"); await writeFile(path, JSON.stringify(cfg), { mode: 0o600 });
    server = spawn(".local/desktop/obsidiansync", ["--config", path, "--test-schema", `e2e_${randomId().slice(0, 16)}`], { stdio: ["ignore", "pipe", "pipe"] });
    let logs = ""; server.stderr?.on("data", d => { logs += String(d); });
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`test service failed: ${logs}`);
      try { await new Transport(endpoint, config.devices[0]!.token, nativeHTTP).handshake(); break; } catch { if (Date.now() > deadline) throw new Error("test service startup timeout"); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const make = async (index: number, http = nativeHTTP) => {
      const dir = join(root, `vault-${index}`); await mkdir(dir); const port = new DiskVault(dir); const db = new SyncDB(`e2e-${randomId()}`); dbs.push(db);
      const device = config.devices[index]!; const engine = new SyncEngine(db, new Transport(endpoint, device.token, http), port, device.id, config.vaultId);
      await engine.unlock("public-e2e-test-passphrase"); return { engine, port };
    };
    const aa = await make(0, async r => {
      if (blockUploads && r.method === "PUT" && r.url.includes("/objects/")) throw new Error("INJECTED_OFFLINE_UPLOAD");
      if (raceResolution && r.url.endsWith("/commits") && ((v) => v.request ?? v)(JSON.parse(new TextDecoder().decode(r.body))).actions[0].type === "resolve") {
        const race = raceResolution; raceResolution = undefined; await race();
      }
      const result = await nativeHTTP(r); if (dropReceipt && r.url.endsWith("/commits") && result.status === 200) { dropReceipt = false; throw new Error("INJECTED_LOST_RESPONSE"); } return result;
    }); a = aa.engine; va = aa.port;
    const bb = await make(1); b = bb.engine; vb = bb.port;
  }, 20_000);
  afterAll(async () => {
    a?.lock(); b?.lock(); for (const db of dbs) await db.delete();
    if (server && server.exitCode === null) { const done = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGTERM"); await done; }
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("syncs text and binary while staging/transport remain ciphertext", async () => {
    await va.edit("note.md", "# private synthetic note 🐇\n共同版本 A\n");
    expect((await a.sync()).errors).toEqual([]); expect((await b.sync()).errors).toEqual([]);
    expect(await vb.text("note.md")).toBe(await va.text("note.md"));
    const payload = enc.encode("synthetic binary attachment\u0000"); await writeFile(join(va.root, "attachment.bin"), payload);
    await a.sync(); await b.sync(); expect(await vb.read("attachment.bin")).toEqual(payload);
    const objectFiles = await readdir(join(root, "objects", config.vaultId));
    for (const file of objectFiles) expect((await readFile(join(root, "objects", config.vaultId, file), "utf8")).includes("private synthetic note")).toBe(false);
  });
  it("lost receipt retry does not steal newer local bytes or duplicate versions", async () => {
    await va.edit("note.md", "电脑 A：版本 B\n"); dropReceipt = true;
    expect((await a.sync()).errors).toContain("INJECTED_LOST_RESPONSE"); expect(await a.db.outbox.count()).toBe(1);
    await va.edit("note.md", "电脑 A：继续编辑 C\n"); expect((await a.sync()).errors).toEqual([]);
    await b.sync(); expect(await vb.text("note.md")).toBe("电脑 A：继续编辑 C\n"); expect(await a.db.outbox.count()).toBe(0);
  });
  it("preserves concurrent text, permits other files, rejects stale review, then keeps both once", async () => {
    await va.edit("note.md", "电脑 A 的离线分支\n"); await vb.edit("note.md", "电脑 B 的离线分支\n");
    await a.sync(); await b.sync(); await a.sync();
    expect(await va.text("note.md")).toBe("电脑 A 的离线分支\n"); expect(await vb.text("note.md")).toBe("电脑 B 的离线分支\n");
    const conflict = (await a.db.conflicts.toArray()).find(c => c.path === "note.md")!; expect(conflict).toBeDefined();
    const stale = await a.review(conflict.id); expect(stale.versions.map(v => v.device).sort()).toEqual(["测试电脑 A", "测试电脑 B"]);
    await va.edit("unrelated.md", "其他文件继续同步\n"); await a.sync(); await b.sync(); expect(await vb.text("unrelated.md")).toBe("其他文件继续同步\n");
    await vb.edit("note.md", "电脑 B 在审阅期间继续修改\n"); await b.sync();
    await expect(a.resolve(stale, stale.versions[0]!.revision)).rejects.toThrow("REVIEW_STALE");
    await a.sync(); const candidate = await a.review(conflict.id); const candidateA = candidate.versions.find(v => v.device === "测试电脑 A")!;
    raceResolution = async () => { await vb.edit("note.md", "电脑 B 在提交选择前又修改\n"); await b.sync(); };
    await expect(a.resolve(candidate, candidateA.revision)).rejects.toThrow("REVIEW_STALE");
    expect(await a.db.rejectedOutbox.count()).toBe(1); expect(await a.db.outbox.count()).toBe(0);
    const fresh = await a.review(conflict.id); const selected = fresh.versions.find(v => v.device === "测试电脑 A")!;
    await a.resolve(fresh, selected.revision, "note-保留电脑B.md"); await b.sync(); await a.sync();
    expect(await va.text("note.md")).toBe("电脑 A 的离线分支\n"); expect(await vb.text("note.md")).toBe(await va.text("note.md"));
    expect(await va.text("note-保留电脑B.md")).toBe("电脑 B 在提交选择前又修改\n"); expect(await vb.text("note-保留电脑B.md")).toBe(await va.text("note-保留电脑B.md"));
    expect((await a.status()).conflicts).toBe(0);
  });
  it("rename and offline content edit converge through separate version domains", async () => {
    await rename(join(va.root, "unrelated.md"), join(va.root, "renamed.md")); await a.rename("unrelated.md", "renamed.md");
    await vb.edit("unrelated.md", "离线正文更新\n"); await a.sync(); await b.sync(); await a.sync();
    expect(await va.text("renamed.md")).toBe("离线正文更新\n"); expect(await vb.text("renamed.md")).toBe("离线正文更新\n"); expect(await vb.text("unrelated.md")).toBe(null);
  });
  it("recovers after Vault write before DB acknowledgement, then protects a later local edit", async () => {
    await va.edit("renamed.md", "恢复检查 1\n"); await a.sync();
    b.fault = point => { if (point === "after-vault-write") throw new Error("INJECTED_AFTER_WRITE"); };
    expect((await b.sync()).errors).toContain("INJECTED_AFTER_WRITE"); expect(await b.db.applyTasks.count()).toBeGreaterThan(0);
    b.fault = undefined; expect((await b.sync()).errors).toEqual([]); expect(await b.db.applyTasks.count()).toBe(0); expect(await vb.text("renamed.md")).toBe("恢复检查 1\n");
    await va.edit("renamed.md", "恢复检查 2\n"); await a.sync(); b.fault = point => { if (point === "after-vault-write") throw new Error("INJECTED_AFTER_WRITE"); }; await b.sync();
    b.fault = undefined; await vb.edit("renamed.md", "退出后用户又写的新内容\n"); const status = await b.sync();
    expect(await vb.text("renamed.md")).toBe("退出后用户又写的新内容\n"); expect(status.state).toBe("needs-attention"); expect(await b.db.applyTasks.count()).toBeGreaterThan(0);
  });
  it("does not turn a failed scan into deletion evidence", async () => {
    const original = va.list.bind(va); const transport = new Transport(endpoint, config.devices[0]!.token, nativeHTTP);
    const before = await transport.handshake(); va.list = async () => { throw new Error("INJECTED_SCAN_FAILURE"); };
    try { expect((await a.sync()).errors).toContain("INJECTED_SCAN_FAILURE"); expect((await transport.handshake()).seq).toBe(before.seq); }
    finally { va.list = original; }
  });
  it("retains deletion versus concurrent edit until an explicit user resolution", async () => {
    await va.edit("delete-edit.md", "共同内容\n"); await a.sync(); await b.sync();
    await unlink(join(va.root, "delete-edit.md")); await vb.edit("delete-edit.md", "电脑 B 离线修改\n");
    await a.sync(); await b.sync(); await a.sync();
    expect(await va.text("delete-edit.md")).toBe(null); expect(await vb.text("delete-edit.md")).toBe("电脑 B 离线修改\n");
    const conflict = (await a.db.conflicts.toArray()).find(c => c.path === "delete-edit.md")!; const review = await a.review(conflict.id);
    expect(review.versions.map(v => v.kind).sort()).toEqual(["deleted", "file"]);
    const retained = review.versions.find(v => v.kind === "file")!; await a.resolve(review, retained.revision); await b.sync();
    expect(await va.text("delete-edit.md")).toBe("电脑 B 离线修改\n"); expect(await vb.text("delete-edit.md")).toBe("电脑 B 离线修改\n");
  });
  it("wrong key never initializes local metadata", async () => {
    const db = new SyncDB(`wrong-key-${randomId()}`); dbs.push(db); const d = config.devices[0]!;
    const engine = new SyncEngine(db, new Transport(endpoint, d.token, nativeHTTP), va, d.id, config.vaultId);
    await expect(engine.unlock("wrong passphrase")).rejects.toThrow(); expect(await db.progress.count()).toBe(0); expect(await db.outbox.count()).toBe(0); engine.lock();
  });
  it("restores protected material offline and blocks a changed remote key package before publishing", async () => {
    const material = a.rememberedMaterial(); a.lock(); let online = false; let changedPackage = false; let calls = 0;
    const d = config.devices[0]!;
    const remote = new Transport(endpoint, d.token, async request => {
      if (blockUploads && request.method === "PUT" && request.url.includes("/objects/")) throw new Error("INJECTED_OFFLINE_UPLOAD");
      calls++; if (!online) throw new Error("OFFLINE");
      const result = await nativeHTTP(request);
      if (changedPackage && request.url.endsWith("/handshake")) {
        const h = JSON.parse(new TextDecoder().decode(result.bytes)); h.keyPackage = { ...h.keyPackage, changed: true };
        return { ...result, bytes: enc.encode(JSON.stringify(h)) };
      }
      return result;
    });
    const resumed = new SyncEngine(a.db, remote, va, d.id, config.vaultId); a = resumed;
    await resumed.restoreRemembered(material); expect(resumed.unlocked).toBe(true); expect(calls).toBe(0);
    await va.edit("resume-after-restart.md", "自动恢复后保留的编辑\n");
    expect((await resumed.sync()).errors).toContain("OFFLINE"); expect(await va.text("resume-after-restart.md")).toBe("自动恢复后保留的编辑\n");
    online = true; expect((await resumed.sync()).errors).toEqual([]); await b.sync(); expect(await vb.text("resume-after-restart.md")).toBe("自动恢复后保留的编辑\n");
    const original = new Transport(endpoint, d.token, nativeHTTP); const seq = (await original.handshake()).seq;
    changedPackage = true; await va.edit("resume-after-restart.md", "新密钥包未核对时不得上传\n");
    expect((await resumed.sync()).errors).toContain("KEY_PACKAGE_CHANGED"); expect((await original.handshake()).seq).toBe(seq);
    expect(await resumed.db.outbox.count()).toBe(0); changedPackage = false;
  });
  it("excluded tracked files are never inferred as deletes and re-inclusion preserves concurrent branches", async () => {
    await va.edit("filter-rule.txt", "base\n"); await a.sync(); await b.sync();
    const local = await a.db.localFiles.where("path").equals("filter-rule.txt").first();
    a.setPolicy(new SyncPolicy({ ...defaultRules(), suffixes: [".txt"] }));
    await unlink(join(va.root, "filter-rule.txt")); await vb.edit("filter-rule.txt", "B changed while A excluded\n"); await b.sync(); await a.sync();
    expect((await a.db.localFiles.get(local!.id))?.deleted).toBe(false); expect(await va.text("filter-rule.txt")).toBeNull(); expect(await a.db.skipped.get("filter-rule.txt")).toBeDefined();
    a.setPolicy(new SyncPolicy()); await a.sync(); await b.sync(); await a.sync();
    const conflict = (await a.db.conflicts.toArray()).find(c => c.path === "filter-rule.txt")!; const review = await a.review(conflict.id);
    expect(review.versions.map(v => v.kind).sort()).toEqual(["deleted", "file"]);
    const keep = review.versions.find(v => v.kind === "file")!; await a.resolve(review, keep.revision); await b.sync();
    expect(await va.text("filter-rule.txt")).toBe("B changed while A excluded\n"); expect(await vb.text("filter-rule.txt")).toBe(await va.text("filter-rule.txt"));
  });
  it("parks excluded outbox entries, permits unrelated files, and retries exact queued snapshots when re-included", async () => {
    await mkdir(join(va.root, "queued")); await va.edit("queued/note.md", "queued original\n"); blockUploads = true;
    expect((await a.sync()).errors).toContain("INJECTED_OFFLINE_UPLOAD"); blockUploads = false;
    const before = await new Transport(endpoint, config.devices[0]!.token, nativeHTTP).handshake();
    a.setPolicy(new SyncPolicy({ ...defaultRules(), folders: ["queued"] })); await a.sync();
    expect((await new Transport(endpoint, config.devices[0]!.token, nativeHTTP).handshake()).seq).toBe(before.seq);
    expect((await a.db.outbox.toArray()).some(row => row.error === "EXCLUDED_BY_RULE")).toBe(true);
    await va.edit("unrelated-filter.md", "other file continues\n"); await a.sync(); await b.sync(); expect(await vb.text("unrelated-filter.md")).toBe("other file continues\n"); expect(await vb.text("queued/note.md")).toBeNull();
    await va.edit("queued/note.md", "queued later bytes\n"); a.setPolicy(new SyncPolicy()); await a.sync(); await b.sync();
    expect(await vb.text("queued/note.md")).toBe("queued later bytes\n"); expect(await a.db.outbox.count()).toBe(0);
  });
  it("manual merge uses reviewed heads, persists encrypted drafts, and rejects a later unseen version", async () => {
    await va.edit("manual-merge.md", "base\n"); await a.sync(); await b.sync();
    await va.edit("manual-merge.md", "A\n"); await vb.edit("manual-merge.md", "B\n"); await a.sync(); await b.sync(); await a.sync();
    const conflict = (await a.db.conflicts.toArray()).find(c => c.path === "manual-merge.md")!; const stale = await a.review(conflict.id);
    await a.saveMergeDraft(conflict.id, "A + B draft\n"); expect(await a.loadMergeDraft(conflict.id)).toBe("A + B draft\n");
    const row = await a.db.mergeDrafts.get(conflict.id); expect(new TextDecoder().decode(row!.ciphertext)).not.toContain("A + B draft");
    await vb.edit("manual-merge.md", "B newer\n"); await b.sync();
    await expect(a.resolve(stale, "", undefined, enc.encode("A + B draft\n"))).rejects.toThrow("REVIEW_STALE"); expect(await a.loadMergeDraft(conflict.id)).toBe("A + B draft\n");
    const latest = await a.review(conflict.id); await a.resolve(latest, "", undefined, enc.encode("A + B newer merged\n")); await b.sync();
    expect(await va.text("manual-merge.md")).toBe("A + B newer merged\n"); expect(await vb.text("manual-merge.md")).toBe(await va.text("manual-merge.md")); expect(await a.db.mergeDrafts.get(conflict.id)).toBeUndefined();
  });
  it("recovers a rejected initial create after interruption without losing either independent version", async () => {
    const material = b.rememberedMaterial(); b.lock(); let offlineUpload = true; const d = config.devices[1]!;
    b = new SyncEngine(b.db, new Transport(endpoint, d.token, async r => { if (offlineUpload && r.method === "PUT" && r.url.includes("/objects/")) throw new Error("INJECTED_INITIAL_OFFLINE"); return nativeHTTP(r); }), vb, d.id, config.vaultId);
    await b.restoreRemembered(material); await vb.edit("initial-collision.md", "B independent original\n"); expect((await b.sync()).errors).toContain("INJECTED_INITIAL_OFFLINE");
    await va.edit("initial-collision.md", "A independent original\n"); await a.sync(); offlineUpload = false;
    b.fault = point => { if (point === "after-collision-archive") throw new Error("INJECTED_AFTER_COLLISION_ARCHIVE"); };
    expect((await b.sync()).errors).toContain("INJECTED_AFTER_COLLISION_ARCHIVE"); expect(await b.db.reconciliations.count()).toBeGreaterThan(0); expect(await vb.text("initial-collision.md")).toBe("B independent original\n");
    b.fault = undefined; await b.sync(); await a.sync(); const conflict = (await a.db.conflicts.toArray()).find(c => c.path === "initial-collision.md")!; const review = await a.review(conflict.id);
    expect(review.versions.map(v => v.text).sort()).toEqual(["A independent original\n", "B independent original\n"]); for (const v of review.versions) expect((await a.db.revisions.get(v.revision))!.parents).toEqual([]);
    const chosen = review.versions.find(v => v.text!.startsWith("A"))!; await a.resolve(review, chosen.revision, "initial-collision-B.md"); await b.sync(); expect(await b.db.outbox.count()).toBe(0);
    expect(await b.db.reconciliations.count()).toBe(0);
    expect((await b.db.rejectedOutbox.toArray()).some(row => row.error === "INITIAL_PATH_COLLISION")).toBe(false);
  });
  it("publishes encrypted per-device configuration with atomic normalized-name uniqueness", async () => {
    const ta = new Transport(endpoint, config.devices[0]!.token, nativeHTTP), tb = new Transport(endpoint, config.devices[1]!.token, nativeHTTP);
    const own = (await ta.devices()).find(d => d.id === a.deviceId)!;
    const value = { format: 1, name: "E2E Mac", platform: "macOS", pluginVersion: "0.0.6", autoSync: true, rules: { ...defaultRules(), folders: ["local-private-folder"], maxMB: 20 } };
    const request = { name: value.name, expectedRevision: own.revision, ciphertext: a.sealProfile(own.revision + 1, value) };
    const saved = await ta.putProfile(request); expect(request.ciphertext).not.toContain("local-private-folder"); expect(await ta.putProfile(request)).toEqual(saved);
    const remote = (await tb.devices()).find(d => d.id === a.deviceId)!; expect(b.openProfile(remote.id, remote.revision, remote.ciphertext!)).toEqual(value);
    const ownB = (await tb.devices()).find(d => d.id === b.deviceId)!;
    await expect(tb.putProfile({ name: "  Ｅ２Ｅ ＭＡＣ  ", expectedRevision: ownB.revision, ciphertext: "opaque" })).rejects.toThrow("DEVICE_NAME_TAKEN");
  });
  it("syncs actual hidden configuration through Adapter while preserving each device's credentials and layout", async () => {
    const makeApp = (root: string): App => {
      const walk = (dir: string, prefix = ""): { path: string; stat: { size: number } }[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => { if (e.name.startsWith(".")) return []; const path = prefix ? prefix + "/" + e.name : e.name; return e.isDirectory() ? walk(join(dir, e.name), path) : [{ path, stat: { size: statSync(join(root, path)).size } }]; });
      const adapter = {
        exists: async (p: string) => { try { await readFile(join(root, p)); return true; } catch { try { return statSync(join(root, p)).isDirectory(); } catch { return false; } } },
        list: async (p: string) => { const entries = await readdir(join(root, p), { withFileTypes: true }); return { files: entries.filter(e => e.isFile()).map(e => p + "/" + e.name), folders: entries.filter(e => e.isDirectory()).map(e => p + "/" + e.name) }; },
        stat: async (p: string) => { try { const v = statSync(join(root, p)); return { type: v.isDirectory() ? "folder" : "file", size: v.size, mtime: v.mtimeMs }; } catch { return null; } },
        remove: async (p: string) => { await unlink(join(root, p)); },
        readBinary: async (p: string) => { const b = await readFile(join(root, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        writeBinary: async (p: string, bytes: ArrayBuffer) => { await writeFile(join(root, p), new Uint8Array(bytes)); },
        process: async (p: string, fn: (text: string) => string) => { const result = fn(await readFile(join(root, p), "utf8")); await writeFile(join(root, p), result); return result; },
        mkdir: async (p: string) => { await mkdir(join(root, p), { recursive: true }); }, rename: async (a: string, b: string) => rename(join(root, a), join(root, b)), trashLocal: async (p: string) => unlink(join(root, p)),
      };
      const vault = { configDir: ".custom-config", adapter, getFolderByPath: (p: string) => { try { return statSync(join(root, p)).isDirectory() ? { path: p } : null; } catch { return null; } }, createFolder: async (p: string) => { await adapter.mkdir(p); return { path: p }; }, getFiles: () => walk(root), getFileByPath: (p: string) => { try { const st = statSync(join(root, p)); return st.isFile() ? { path: p, stat: { size: st.size } } : null; } catch { return null; } },
        readBinary: (f: { path: string }) => adapter.readBinary(f.path), createBinary: (p: string, bytes: ArrayBuffer) => adapter.writeBinary(p, bytes), modifyBinary: (f: { path: string }, bytes: ArrayBuffer) => adapter.writeBinary(f.path, bytes), process: (f: { path: string }, fn: (v: string) => string) => adapter.process(f.path, fn), rename: (f: { path: string }, p: string) => adapter.rename(f.path, p), trash: (f: { path: string }) => adapter.trashLocal(f.path) };
      return { vault, workspace: { getLeavesOfType: () => [] } } as unknown as App;
    };
    const dirs = [join(root, "config-A"), join(root, "config-B")];
    for (const [i,dir] of dirs.entries()) { await mkdir(join(dir, ".custom-config/obsidian-sync-local"), { recursive: true }); await mkdir(join(dir, ".custom-config/themes/Demo"), { recursive: true }); await mkdir(join(dir, ".custom-config/plugins/example"), { recursive: true });
      await writeFile(join(dir, ".custom-config/app.json"), JSON.stringify({ fontSize: i === 0 ? 16 : 17, deviceId: "device-private-" + i })); await writeFile(join(dir, ".custom-config/workspace.json"), "layout-private-" + i); await writeFile(join(dir, ".custom-config/obsidian-sync-local/device.json"), "identity-private-" + i); await writeFile(join(dir, ".custom-config/plugins/example/data.json"), JSON.stringify({ color: "purple", apiKey: "api-private-" + i })); }
    await writeFile(join(dirs[0]!, ".custom-config/themes/Demo/theme.css"), "body { color: purple; }"); await writeFile(join(dirs[0]!, ".custom-config/plugins/example/main.js"), "/* synthetic plugin bytes */");
    const ports = dirs.map(dir => new ObsidianVaultPort(makeApp(dir), ".custom-config/obsidian-sync-local")); const engines: SyncEngine[] = [];
    for (let i = 0; i < 2; i++) { const db = new SyncDB(`config-e2e-${randomId()}`); dbs.push(db); const d = config.devices[i + 2]!; const e = new SyncEngine(db, new Transport(endpoint, d.token, nativeHTTP), ports[i]!, d.id, config.vaultId); await e.unlock("public-e2e-test-passphrase"); engines.push(e); }
    try {
      expect((await engines[0]!.sync()).errors).toEqual([]); expect((await engines[1]!.sync()).errors).toEqual([]);
      expect(await readFile(join(dirs[1]!, ".custom-config/themes/Demo/theme.css"), "utf8")).toBe("body { color: purple; }"); expect(await readFile(join(dirs[1]!, ".custom-config/plugins/example/main.js"), "utf8")).toBe("/* synthetic plugin bytes */");
      await engines[0]!.sync();
      const initialConflict = (await engines[0]!.db.conflicts.toArray()).find(c => c.path === ".obsidian/app.json")!;
      expect(initialConflict).toBeDefined(); const initialReview = await engines[0]!.review(initialConflict.id);
      const initialA = initialReview.versions.find(v => JSON.parse(v.text!).fontSize === 16)!;
      expect((await engines[0]!.db.revisions.get(initialA.revision))!.parents).toEqual([]);
      await engines[0]!.resolve(initialReview, initialA.revision); await engines[1]!.sync();
      await writeFile(join(dirs[1]!, ".custom-config/app.json"), JSON.stringify({ fontSize: 19, deviceId: "device-private-1" })); await writeFile(join(dirs[1]!, ".custom-config/plugins/example/data.json"), JSON.stringify({ color: "green", apiKey: "api-private-1" }));
      await engines[1]!.sync(); await engines[0]!.sync();
      expect(JSON.parse(await readFile(join(dirs[0]!, ".custom-config/app.json"), "utf8"))).toEqual({ fontSize: 19, deviceId: "device-private-0" }); expect(JSON.parse(await readFile(join(dirs[0]!, ".custom-config/plugins/example/data.json"), "utf8"))).toEqual({ color: "green", apiKey: "api-private-0" });
      expect(await readFile(join(dirs[0]!, ".custom-config/workspace.json"), "utf8")).toBe("layout-private-0"); expect(await readFile(join(dirs[1]!, ".custom-config/obsidian-sync-local/device.json"), "utf8")).toBe("identity-private-1");
      const remote = await engines[0]!.db.remoteFiles.toArray(); expect(remote.length).toBeGreaterThan(0); expect(dec.decode((await ports[0]!.read(".obsidian/plugins/example/data.json"))!)).not.toContain("api-private");
    } finally { engines.forEach(e => e.lock()); }
  }, 20000);
  it("transfers an exact 100 MB attachment as bounded ciphertext objects and rejects a larger file", async () => {
    const bytes = new Uint8Array(100_000_000); bytes[0] = 19; bytes[bytes.length - 1] = 91;
    await writeFile(join(va.root, "limit-100MB.pdf"), bytes);
    b.setPolicy(new SyncPolicy({ ...defaultRules(), maxMB: 20 }));
    expect((await a.sync()).errors).toEqual([]); expect((await b.sync()).errors).toEqual([]);
    expect(await vb.read("limit-100MB.pdf")).toBeNull(); expect((await b.db.skipped.get("limit-100MB.pdf"))?.reason).toContain("20 MB");
    b.setPolicy(new SyncPolicy()); expect((await b.sync()).errors).toEqual([]);
    expect((await readFile(join(vb.root, "limit-100MB.pdf"))).equals(Buffer.from(bytes.buffer))).toBe(true);
    const file = await a.db.localFiles.where("path").equals("limit-100MB.pdf").first(); const revision = await a.db.revisions.get(file!.revision); expect(revision!.payload.objects.length).toBeGreaterThan(1);
    const storedObjects = await readdir(join(root, "objects", config.vaultId));
    for (const id of revision!.payload.objects) {
      const physical = storedObjects.find(name => name.startsWith(`${id}.s`) && /^[a-f0-9]{64}$/.test(name.slice(id.length + 2)));
      expect(physical).toBeDefined();
      expect((await readFile(join(root, "objects", config.vaultId, physical!))).length).toBeLessThan(16 * 1024 * 1024);
    }
    await writeFile(join(va.root, "over-limit.pdf"), new Uint8Array(100_000_001)); await a.sync(); expect(await a.db.skipped.get("over-limit.pdf")).toBeDefined(); expect(await a.db.localFiles.where("path").equals("over-limit.pdf").first()).toBeUndefined();
    await unlink(join(va.root, "over-limit.pdf")); await unlink(join(va.root, "limit-100MB.pdf")); await unlink(join(vb.root, "limit-100MB.pdf"));
  }, 90000);

});
