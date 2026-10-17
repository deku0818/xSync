import "fake-indexeddb/auto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncPolicy, defaultRules } from "../../plugin/src/sync/policy.js";
import { RecoveryFixture } from "./recovery-support.js";

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("incremental sync with real files/HTTP/PG", () => {
  let fixture: RecoveryFixture;
  beforeEach(async () => { fixture = new RecoveryFixture(); await fixture.open(); await fixture.client(0); await fixture.client(1); });
  afterEach(async () => { vi.restoreAllMocks(); await fixture.close(); });
  it("initializes a new local database with a full scan even when the caller requests an incremental round", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("existing.md", "existing note without a notification");
    expect((await a.engine.sync({ full: false })).errors).toEqual([]);
    await b.engine.sync({ full: false }); expect(await b.files.text("existing.md")).toBe("existing note without a notification");
  });
  it("does no source reads when idle and reads only a notified file after a restart", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    for (let i = 0; i < 30; i++) await a.files.edit(`note-${i}.md`, `base ${i}`);
    await a.engine.sync(); await b.engine.sync();
    a.files.stat = async path => { try { return { size: (await stat(a.files.path(path))).size }; } catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; } };
    const reads: string[] = []; a.files.hook = async (operation, path) => { if (operation === "read") reads.push(path); };
    const list = vi.spyOn(a.files, "list");
    expect((await a.engine.sync({ full: false })).errors).toEqual([]);
    expect(reads).toEqual([]); expect(list).not.toHaveBeenCalled();
    await a.files.edit("note-3.md", "latest local content"); await a.db.markDirty("note-3.md");
    const reopened = await fixture.reopen(0); expect((await reopened.engine.sync({ full: false })).errors).toEqual([]);
    expect(reads).toEqual(["note-3.md"]); expect(await reopened.db.dirtyFiles.count()).toBe(0);
    await b.engine.sync({ full: false }); expect(await b.files.text("note-3.md")).toBe("latest local content");
  }, 30000);
  it("replays an immutable pre-upgrade request body using the current snapshot capability", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    a.db.outbox.hook("creating", (_key, row) => { row.request.requiredFeatures = row.request.requiredFeatures.map(feature => feature === "snapshot-pages-v2" ? "snapshot-pages-v1" : feature); });
    fixture.httpHook = async (request, next) => request.url.endsWith("/metadata/commits")
      ? { status: 429, headers: {}, bytes: new TextEncoder().encode('{"code":"CONTENT_BUSY"}') } : next();
    await a.files.edit("upgrade.md", "old queued bytes"); await a.engine.sync();
    const original = (await a.db.outbox.toArray())[0]!.request; expect(original.requiredFeatures).toContain("snapshot-pages-v1");
    const reopened = await fixture.reopen(0); let replayed = false;
    fixture.httpHook = async (request, next) => {
      if (request.url.endsWith("/metadata/commits")) { expect(JSON.parse(new TextDecoder().decode(request.body!)).request).toEqual(original); expect(request.headers["X-Sync-Snapshots"]).toBe("snapshot-pages-v2"); replayed = true; }
      return next();
    };
    expect((await reopened.engine.sync({ full: false })).errors).toEqual([]); expect(replayed).toBe(true);
    fixture.httpHook = undefined; await b.engine.sync(); expect(await b.files.text("upgrade.md")).toBe("old queued bytes");
  });
  it("keeps a newer event arriving during capture and retains immutable pending uploads", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("note.md", "base"); await a.engine.sync(); await b.engine.sync();
    await a.files.edit("note.md", "first change"); await a.db.markDirty("note.md"); let changed = false;
    a.files.hook = async operation => { if (!changed && operation === "stageWrite") { changed = true; await a.files.edit("note.md", "newer typing"); await a.db.markDirty("note.md"); } };
    fixture.httpHook = async (request, next) => request.url.endsWith("/content/upload")
      ? { status: 429, headers: {}, bytes: new TextEncoder().encode('{"code":"CONTENT_BUSY"}') } : next();
    await a.engine.sync({ full: false }); expect(await a.db.dirtyFiles.count()).toBe(1);
    const original = (await a.db.outbox.toArray())[0]!.request;
    const reopened = await fixture.reopen(0); await reopened.engine.sync({ full: false });
    expect((await reopened.db.outbox.toArray())[0]!.request).toEqual(original); expect(await reopened.files.text("note.md")).toBe("newer typing");
    fixture.httpHook = undefined; expect((await reopened.engine.sync({ full: false })).errors).toEqual([]);
    await b.engine.sync({ full: false }); expect(await b.files.text("note.md")).toBe("newer typing");
  });
  it("captures missed local changes on an incoming target and never overwrites them", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("note.md", "base"); await a.engine.sync(); await b.engine.sync();
    await a.files.edit("note.md", "local edit without a hint"); await b.files.edit("note.md", "peer edit"); await b.engine.sync();
    expect((await a.engine.sync({ full: false })).conflicts).toBe(1);
    const id = (await a.db.conflicts.toArray())[0]!.id;
    expect((await a.engine.review(id)).versions.map(v => v.text).sort()).toEqual(["local edit without a hint", "peer edit"]);
    expect(await a.files.text("note.md")).toBe("local edit without a hint");
  });
  it.each(["size", "rule"])("finishes a skipped dirty hint for %s and syncs a later eligible edit", async kind => {
    const a = fixture.clients[0]!;
    const b = fixture.clients[1]!;
    await a.engine.sync();
    await b.engine.sync();
    await a.files.edit("skipped.md", kind === "size" ? "x".repeat(1_000_001) : "excluded text");
    await a.db.markDirty("skipped.md");
    a.engine.setPolicy(new SyncPolicy({ ...defaultRules(), maxMB: 1, suffixes: kind === "rule" ? [".md"] : [] }));
    const status = await a.engine.sync({ full: false });
    expect(status.errors).toEqual([]);
    expect(status.skipped).toBe(1);
    expect(await a.db.dirtyFiles.count()).toBe(0);
    expect(status.state).toBe("complete");
    a.engine.setPolicy(new SyncPolicy());
    await a.files.edit("skipped.md", "now eligible");
    await a.db.markDirty("skipped.md");
    expect((await a.engine.sync({ full: false })).errors).toEqual([]);
    await b.engine.sync({ full: false });
    expect(await b.files.text("skipped.md")).toBe("now eligible");
    expect(await a.db.skipped.count()).toBe(0);
  });
  it.each(["stat", "read"])("retains a newer hint when an oversized snapshot is skipped after %s", async boundary => {
    const a = fixture.clients[0]!;
    const b = fixture.clients[1]!;
    await a.engine.sync();
    await b.engine.sync();
    a.engine.setPolicy(new SyncPolicy({ ...defaultRules(), maxMB: 1 }));
    await a.files.edit("changing.md", "x".repeat(1_000_001));
    await a.db.markDirty("changing.md");
    async function editAgain(): Promise<void> {
      await a.files.edit("changing.md", "new small content");
      await a.db.markDirty("changing.md");
    }
    if (boundary === "stat") {
      vi.spyOn(a.files, "stat").mockImplementationOnce(async () => {
        await editAgain();
        return { size: 1_000_001 };
      });
    } else {
      vi.spyOn(a.files, "stat").mockResolvedValue({ size: 1 });
      const read = a.files.read.bind(a.files);
      vi.spyOn(a.files, "read").mockImplementationOnce(async path => {
        const snapshot = await read(path);
        await editAgain();
        return snapshot;
      });
    }
    expect((await a.engine.sync({ full: false })).errors).toEqual([]);
    expect((await a.db.dirtyFiles.get("changing.md"))?.generation).toBe(2);
    expect((await a.engine.sync({ full: false })).errors).toEqual([]);
    await b.engine.sync({ full: false });
    expect(await b.files.text("changing.md")).toBe("new small content");
    expect(await a.db.dirtyFiles.count()).toBe(0);
  });
  it("writes only incoming file/revision rows and leaves unrelated local metadata untouched", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    for (const name of ["one.md", "two.md", "three.md"]) await a.files.edit(name, name);
    await a.engine.sync(); await b.engine.sync();
    const files: string[] = [], revisions: string[] = [];
    b.db.remoteFiles.hook("updating", (_mods, key) => { files.push(String(key)); });
    b.db.revisions.hook("updating", (_mods, key) => { revisions.push(String(key)); });
    await a.files.edit("one.md", "updated"); await a.engine.sync();
    expect((await b.engine.sync({ full: false })).errors).toEqual([]);
    const id = (await b.db.localFiles.where("path").equals("one.md").first())!.id;
    expect(new Set(files)).toEqual(new Set([id]));
    expect(revisions.length).toBeLessThanOrEqual(1);
    expect(await b.files.text("one.md")).toBe("updated");
  });
  it("keeps rename identity and concurrent offline edits, then captures a notified deletion", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("old.md", "base"); await a.engine.sync(); await b.engine.sync();
    await rename(a.files.path("old.md"), a.files.path("new.md")); await a.engine.rename("old.md", "new.md");
    await a.db.markDirty("old.md"); await a.db.markDirty("new.md");
    await b.files.edit("old.md", "offline typing");
    await a.engine.sync({ full: false }); expect((await b.engine.sync({ full: false })).errors).toEqual([]);
    await a.engine.sync({ full: false });
    expect(await a.files.text("new.md")).toBe("offline typing"); expect(await b.files.text("new.md")).toBe("offline typing");
    expect(await a.files.text("old.md")).toBeNull(); expect(await a.db.dirtyFiles.count()).toBe(0);
    await unlink(a.files.path("new.md")); await a.db.markDirty("new.md");
    await a.engine.sync({ full: false }); await b.engine.sync({ full: false }); expect(await b.files.text("new.md")).toBeNull();
  });
  it("keeps bounded encrypted apply chunks and every backup across interruption and corruption", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    const old = "a".repeat(9 * 1024 * 1024), latest = "b".repeat(old.length);
    await a.files.edit("large.bin", old); await a.engine.sync(); await b.engine.sync();
    await a.files.edit("large.bin", latest); await a.engine.sync(); let interrupted = false;
    b.engine.fault = point => { if (!interrupted && point === "after-apply-prepare") { interrupted = true; throw new Error("PREPARE_INTERRUPTED"); } };
    await b.engine.sync(); expect(interrupted).toBe(true);
    const task = (await b.db.applyTasks.toArray())[0]!;
    expect(task.chunks).toHaveLength(3); expect(task.backupChunks).toHaveLength(3);
    for (const id of [...task.chunks!, ...task.backupChunks!]) expect((await stat(`${b.files.root}/.stage/${id}`)).size).toBeLessThan(6 * 1024 * 1024);
    const path = `${b.files.root}/.stage/${task.chunks![2]}`, original = await readFile(path), damaged = Uint8Array.from(original); damaged[damaged.length - 1] = 0;
    await writeFile(path, damaged);
    const reopened = await fixture.reopen(1); expect((await reopened.engine.sync()).errors).toContain("APPLY_RECOVERY_FAILED: large.bin");
    expect(await reopened.files.text("large.bin")).toBe(old);
    expect(await reopened.files.stageList()).toEqual(expect.arrayContaining(task.backupChunks!));
    await writeFile(path, original); expect((await reopened.engine.sync()).errors).toEqual([]);
    expect(await reopened.files.text("large.bin")).toBe(latest); expect(await reopened.files.stageList()).toEqual([]);
  }, 30000);
  it("does not block healthy uploads when a queued path is temporarily absent from the index", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.engine.sync(); await b.engine.sync();
    await a.db.markDirty("not-indexed.md"); await a.files.edit("healthy.md", "healthy content");
    a.files.hook = async (operation, path) => { if (operation === "read" && path === "not-indexed.md") throw new Error("VAULT_INDEX_NOT_READY"); };
    expect((await a.engine.sync()).errors).toContain("VAULT_INDEX_NOT_READY");
    await b.engine.sync({ full: false }); expect(await b.files.text("healthy.md")).toBe("healthy content");
    expect(await a.db.dirtyFiles.count()).toBe(1);
  });
  it("full reconciliation catches dropped notifications without inferring deletion from scan failure", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("note.md", "base"); await a.engine.sync(); await b.engine.sync();
    await a.files.edit("note.md", "missed event");
    await a.engine.sync({ full: false }); await b.engine.sync({ full: false }); expect(await b.files.text("note.md")).toBe("base");
    expect((await a.engine.sync()).errors).toEqual([]); await b.engine.sync({ full: false }); expect(await b.files.text("note.md")).toBe("missed event");
    vi.spyOn(a.files, "list").mockRejectedValueOnce(new Error("SCAN_FAILED"));
    expect((await a.engine.sync()).errors).toContain("SCAN_FAILED"); expect(await b.files.text("note.md")).toBe("missed event");
  });
});
