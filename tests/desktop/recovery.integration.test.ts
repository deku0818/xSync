import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { fingerprint } from "../../plugin/src/sync/crypto";
import { RecoveryFixture } from "./recovery-support";

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("recovery with real files/HTTP/Docker PG; fake IndexedDB and recreated clients", () => {
  let fixture: RecoveryFixture;
  beforeEach(async () => { fixture = new RecoveryFixture(); await fixture.open(); await fixture.client(0); await fixture.client(1); }, 20000);
  afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await fixture?.close(); });
  const failOnce = (point: string) => { let hit = false; return { get hit() { return hit; }, fault: (current: string) => { if (!hit && current === point) { hit = true; throw new Error(`INJECTED_${point}`); } } }; };
  it.each(["before-snapshot-commit", "after-snapshot-commit", "after-capture-stage", "before-outbox-commit", "after-outbox-commit", "after-object-upload", "after-remote-commit", "after-outbox-ack", "before-local-request-ack-commit", "after-local-request-ack-commit", "before-request-ack-send", "after-request-ack-send", "before-local-cleanup-commit", "after-local-cleanup-commit", "before-stage-remove", "after-stage-remove"])("recovers outgoing/bootstrap boundary %s without duplicate revisions", async point => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "immutable local bytes"); const failure = failOnce(point); a.engine.fault = failure.fault;
    await a.engine.sync(); expect(failure.hit).toBe(true);
    if (point === "before-snapshot-commit") expect(await a.db.progress.count()).toBe(0);
    if (point === "before-outbox-commit") { expect(await a.db.localFiles.count()).toBe(0); expect(await a.db.revisions.count()).toBe(0); expect(await a.db.outbox.count()).toBe(0); }
    const restarted = await fixture.reopen(0); expect((await restarted.engine.sync()).errors).toEqual([]);
    const b = fixture.clients[1]!; expect((await b.engine.sync()).errors).toEqual([]); expect(await b.files.text("note.md")).toBe("immutable local bytes");
    const snapshot = await fixture.transport(0).snapshot(); expect(snapshot.files).toHaveLength(1); expect(snapshot.revisions).toHaveLength(1);
    expect((await restarted.engine.status()).state).toBe("complete");
    expect(await restarted.files.stageList()).toEqual([]); expect(await b.files.stageList()).toEqual([]);
    expect(await restarted.db.inbox.count()).toBe(0); expect(await b.db.inbox.count()).toBe(0);
  });
  it("repeatedly frees completed snapshots and old revisions while retaining the accepted baseline for offline edits", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    for (let i = 0; i < 4; i++) {
      await a.files.edit("note.md", `version ${i}`);
      expect((await a.engine.sync()).errors).toEqual([]);
      expect((await b.engine.sync()).errors).toEqual([]);
      expect(await b.files.text("note.md")).toBe(`version ${i}`);
      expect(await a.files.stageList()).toEqual([]); expect(await b.files.stageList()).toEqual([]);
      expect(await a.db.inbox.count()).toBe(0); expect(await b.db.inbox.count()).toBe(0);
    }
    expect(await b.db.revisions.count()).toBe(1); expect(await b.db.baseProofs.count()).toBe(1);
    await b.files.edit("note.md", "B offline"); await a.files.edit("note.md", "A concurrent");
    await a.engine.sync(); expect((await b.engine.sync()).conflicts).toBe(1);
    const review = await b.engine.review((await b.db.conflicts.toArray())[0]!.id);
    expect(review.versions.map(row => row.text).sort()).toEqual(["A concurrent", "B offline"]);
  });
  it("retries a failed stage deletion without repeating the already accepted upload", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "accepted before cleanup failed");
    a.files.hook = async op => { if (op === "stageRemove") throw new Error("INJECTED_CLEANUP_IO"); };
    expect((await a.engine.sync()).errors).toContain("INJECTED_CLEANUP_IO");
    const before = await fixture.transport(0).handshake();
    expect(await a.db.outbox.count()).toBe(0); expect((await a.files.stageList()).length).toBeGreaterThan(0);
    a.files.hook = undefined; const restarted = await fixture.reopen(0);
    expect((await restarted.engine.sync()).errors).toEqual([]); expect(await restarted.files.stageList()).toEqual([]);
    expect((await fixture.transport(0).handshake()).seq).toBe(before.seq);
  });
  it.each(["before-inbox-commit", "after-inbox-commit", "after-apply-stage", "after-apply-prepare", "after-vault-write", "before-apply-ack", "after-apply-ack", "before-applied-cursor-commit", "after-applied-cursor-commit"])("recovers incoming boundary %s and never acknowledges before filesystem application", async point => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await b.engine.sync();
    await a.files.edit("note.md", "exact received bytes"); await a.engine.sync(); const before = (await b.db.progress.get("progress"))!;
    const failure = failOnce(point); b.engine.fault = failure.fault; await b.engine.sync(); expect(failure.hit).toBe(true);
    if (point === "before-inbox-commit") { expect((await b.db.progress.get("progress"))!.received).toBe(before.received); expect(await b.db.remoteFiles.count()).toBe(0); }
    if (point === "before-apply-ack") { expect(await b.db.applyTasks.count()).toBe(1); expect(await b.db.localFiles.count()).toBe(0); }
    const restarted = await fixture.reopen(1); expect((await restarted.engine.sync()).errors).toEqual([]);
    expect(await restarted.files.text("note.md")).toBe("exact received bytes"); expect(await restarted.db.applyTasks.count()).toBe(0);
    const progress = (await restarted.db.progress.get("progress"))!; expect(progress.applied).toBe(progress.received); expect((await restarted.engine.status()).state).toBe("complete");
  });
  it.each(["rename", "delete"])("replays %s after the filesystem changed but its database acknowledgement did not", async kind => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("old.md", "same content"); await a.engine.sync(); await b.engine.sync();
    if (kind === "rename") { await rename(a.files.path("old.md"), a.files.path("new.md")); await a.engine.rename("old.md", "new.md"); } else await unlink(a.files.path("old.md"));
    await a.engine.sync(); const failure = failOnce(kind === "rename" ? "after-vault-rename" : "after-vault-write"); b.engine.fault = failure.fault;
    await b.engine.sync(); expect(failure.hit).toBe(true); const restarted = await fixture.reopen(1);
    expect((await restarted.engine.sync()).errors).toEqual([]); expect(await restarted.files.text("old.md")).toBeNull();
    if (kind === "rename") expect(await restarted.files.text("new.md")).toBe("same content");
    expect(await restarted.db.applyTasks.count()).toBe(0); expect((await restarted.engine.status()).state).toBe("complete");
  });
  it.each(["none", "before-snapshot-commit", "after-snapshot-commit"])("rebuilds an expired change cursor with queued offline intent and snapshot interruption %s", async point => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "common ancestor"); await a.engine.sync(); await b.engine.sync();
    await b.files.edit("note.md", "offline B edit");
    fixture.httpHook = async (request, next) => { if (request.method === "PUT") throw new Error("OFFLINE"); return next(); };
    await b.engine.sync(); fixture.httpHook = undefined; const intent = (await b.db.outbox.toArray())[0]!.request;
    await a.files.edit("note.md", "new A edit"); await a.engine.sync();
    await fixture.expireLog((await fixture.transport(0).handshake()).seq);
    if (point !== "none") {
      const failure = failOnce(point); b.engine.fault = failure.fault; await b.engine.sync(); expect(failure.hit).toBe(true);
      expect((await b.db.outbox.toArray())[0]!.request).toEqual(intent); await fixture.reopen(1);
    }
    const restored = fixture.clients[1]!; const status = await restored.engine.sync(); expect(status.errors).toEqual([]); expect(status.conflicts).toBe(1);
    expect(await restored.files.text("note.md")).toBe("offline B edit"); const conflict = (await restored.db.conflicts.toArray())[0]!;
    const review = await restored.engine.review(conflict.id); expect(review.versions.map(v => v.text).sort()).toEqual(["new A edit", "offline B edit"]);
    await a.engine.sync(); expect(await a.files.text("note.md")).toBe("new A edit");
  });
  it("blocks a coherent old client database checkpoint while preserving newer filesystem bytes", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "base"); await a.engine.sync(); await b.engine.sync();
    const checkpoint = await b.db.localFiles.toArray(); const progress = (await b.db.progress.get("progress"))!;
    const remoteCheckpoint = await b.db.remoteFiles.toArray(), revisionCheckpoint = await b.db.revisions.toArray(), proofCheckpoint = await b.db.baseProofs.toArray();
    const writerCheckpoint = (await b.db.writerState.get("writer"))!;
    const continuityCheckpoint = (await b.db.continuity.get("continuity"))!;
    await a.files.edit("note.md", "remote new version"); await a.engine.sync(); await b.engine.sync();
    // Restore a coherent database checkpoint, including the baseline that compaction may have evicted.
    await b.db.transaction("rw", b.db.tables, async () => {
      await b.db.localFiles.clear(); await b.db.localFiles.bulkPut(checkpoint); await b.db.progress.put(progress);
      await b.db.remoteFiles.clear(); await b.db.remoteFiles.bulkPut(remoteCheckpoint);
      await b.db.revisions.clear(); await b.db.revisions.bulkPut(revisionCheckpoint);
      await b.db.baseProofs.clear(); await b.db.baseProofs.bulkPut(proofCheckpoint); await b.db.writerState.put(writerCheckpoint);
      await b.db.continuity.put(continuityCheckpoint);
    });
    await b.files.edit("note.md", "restored disk plus fresh edit");
    const restarted = await fixture.reopen(1); const status = await restarted.engine.sync(); expect(status.errors).toContain("RECOVERY_RECONCILIATION_REQUIRED");
    expect(await restarted.files.text("note.md")).toBe("restored disk plus fresh edit");
    expect(await restarted.db.continuity.get("continuity")).toEqual(continuityCheckpoint);
    expect(await restarted.db.outbox.count()).toBe(0);
    expect((await fixture.transport(0).snapshot()).files[0]!.heads).toHaveLength(1);
  });
  it.each(["matching", "diverged"])("reconnects after local IndexedDB loss with %s filesystem content without inventing ancestry", async kind => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "remote bytes"); await a.engine.sync(); await b.engine.sync();
    if (kind === "diverged") await b.files.edit("note.md", "local bytes survived database loss");
    b.engine.lock(); await b.db.delete(); const fresh = await fixture.client(1); const status = await fresh.engine.sync(); expect(status.errors).toEqual([]);
    const snapshot = await fixture.transport(0).snapshot();
    if (kind === "matching") { expect(status.state).toBe("complete"); expect(snapshot.revisions).toHaveLength(1); }
    else {
      expect(status.conflicts).toBe(1); expect(await fresh.files.text("note.md")).toBe("local bytes survived database loss");
      const local = (await fresh.db.localFiles.toArray())[0]!; expect((await fresh.db.revisions.get(local.revision))!.parents).toEqual([]);
      expect(snapshot.files[0]!.heads).toHaveLength(2);
    }
  });
  it.each(["epoch", "cursor"])("blocks a rolled-back server %s before any local intent is published", async kind => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "base"); await a.engine.sync(); const before = await fixture.transport(0).handshake(); await a.files.edit("note.md", "offline edit");
    fixture.httpHook = async (request, next) => { const r = await next(); if (request.url.endsWith("/handshake")) { const h = JSON.parse(new TextDecoder().decode(r.bytes)); if (kind === "epoch") h.epoch = "replacement-epoch"; else h.seq = 0; r.bytes = new TextEncoder().encode(JSON.stringify(h)); } return r; };
    expect((await a.engine.sync()).errors).toContain("RECOVERY_RECONCILIATION_REQUIRED"); expect(await a.db.outbox.count()).toBe(0);
    fixture.httpHook = undefined; expect((await fixture.transport(0).handshake()).seq).toBe(before.seq); expect(await a.files.text("note.md")).toBe("offline edit");
  });
  it.each(["expired", "stolen"])("stops filesystem writes when the local lease is %s during stage loading", async kind => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "remote bytes"); await a.engine.sync(); let stolen = false;
    b.files.hook = async op => { if (op === "stageRead" && !stolen) { stolen = true; const lease = (await b.db.leases.get("engine"))!; await b.db.leases.put({ ...lease, ...(kind === "expired" ? { until: 0 } : { owner: "other-live-owner" }) }); } };
    expect((await b.engine.sync()).errors).toContain("LOCAL_LEASE_LOST"); expect(await b.files.text("note.md")).toBeNull(); expect(await b.db.applyTasks.count()).toBe(1);
    b.files.hook = undefined; await b.db.leases.clear(); const restarted = await fixture.reopen(1); expect((await restarted.engine.sync()).errors).toEqual([]); expect(await restarted.files.text("note.md")).toBe("remote bytes");
  });
  it.each(["expired", "released"])("never reacquires a %s lease from a delayed heartbeat during apply recovery", async kind => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("note.md", "remote bytes protected by the journal"); await a.engine.sync();
    let heartbeat: (() => void) | undefined;
    const intervals = vi.spyOn(globalThis, "setInterval").mockImplementation(callback => { heartbeat = callback as () => void; return 0 as unknown as ReturnType<typeof setInterval>; });
    b.files.hook = async operation => {
      if (operation !== "stageRead") return;
      expect(heartbeat).toBeDefined();
      const lease = (await b.db.leases.get("engine"))!;
      if (kind === "expired") await b.db.leases.put({ ...lease, until: 0 });
      else {
        // A different execution acquired, finished and released while this one was suspended.
        await b.db.leases.put({ ...lease, owner: "finished-other-run" }); await b.db.leases.delete("engine");
      }
      heartbeat!(); await vi.waitFor(() => expect(b.engine.unlocked).toBe(false));
      expect(await b.db.leases.get("engine")).toEqual(kind === "expired" ? { ...lease, until: 0 } : undefined);
    };
    expect((await b.engine.sync()).errors).toContain("LOCKED");
    expect(await b.files.text("note.md")).toBeNull(); expect(await b.db.applyTasks.count()).toBe(1); expect((await b.files.stageList()).length).toBeGreaterThan(0);
    intervals.mockRestore(); b.files.hook = undefined; await b.db.leases.clear();
    const restarted = await fixture.reopen(1); expect((await restarted.engine.sync()).errors).toEqual([]);
    expect(await restarted.files.text("note.md")).toBe("remote bytes protected by the journal"); expect(await restarted.files.stageList()).toEqual([]);
  });
  it("renews an explicit conflict resolution across the original lease deadline", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("note.md", "base"); await a.engine.sync(); await b.engine.sync();
    await a.files.edit("note.md", "computer choice"); await a.engine.sync(); await b.files.edit("note.md", "phone choice"); await b.engine.sync();
    const review = await b.engine.review((await b.db.conflicts.toArray())[0]!.id), choice = review.versions.find(v => v.text === "computer choice")!;
    let heartbeat: (() => void) | undefined, clock = Date.now(), renewed = false;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(globalThis, "setInterval").mockImplementation(callback => { heartbeat = callback as () => void; return 0 as unknown as ReturnType<typeof setInterval>; });
    fixture.httpHook = async (request, next) => {
      if (!renewed && new URL(request.url).pathname === "/metadata/commits") {
        renewed = true; expect(heartbeat).toBeDefined(); const before = (await b.db.leases.get("engine"))!;
        clock = before.until - 1; heartbeat!();
        await vi.waitFor(async () => expect((await b.db.leases.get("engine"))!.until).toBeGreaterThan(before.until));
        clock = before.until + 1;
      }
      return next();
    };
    await b.engine.resolve(review, choice.revision); expect(renewed).toBe(true);
    expect(await b.files.text("note.md")).toBe("computer choice"); expect(await b.engine.status()).toMatchObject({ state: "complete", errors: [] });
    expect(await b.db.leases.get("engine")).toBeUndefined(); expect(await b.files.stageList()).toEqual([]);
  });
  it("refuses damaged outgoing ciphertext before publishing an accepted revision", async () => {
    const a = fixture.clients[0]!;
    await a.files.edit("note.md", "original intent");
    fixture.httpHook = async (request, next) => { if (request.method === "PUT") throw new Error("INJECTED_OFFLINE"); return next(); };
    await a.engine.sync(); fixture.httpHook = undefined;
    const row = (await a.db.outbox.toArray())[0]!; const obj = row.objects[0]!;
    const original = await a.files.stageRead(obj.stage); const corrupt = original.slice(); corrupt[corrupt.length - 10]! ^= 1;
    await writeFile(join(a.files.root, ".stage", obj.stage), corrupt);
    const before = await fixture.transport(0).handshake(); const status = await a.engine.sync();
    expect(status.errors.length).toBeGreaterThan(0); expect((await fixture.transport(0).handshake()).seq).toBe(before.seq);
    expect(await a.db.outbox.count()).toBe(1);
    await writeFile(join(a.files.root, ".stage", obj.stage), original);
    expect((await a.engine.sync()).errors).toEqual([]); expect((await fixture.clients[1]!.engine.sync()).errors).toEqual([]);
    expect(await fixture.clients[1]!.files.text("note.md")).toBe("original intent");
  });
  it("continues unrelated uploads when one immutable upload stage is missing", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("broken.md", "preserve missing-stage intent");
    fixture.httpHook = async (request, next) => { if (request.method === "PUT") throw new Error("OFFLINE"); return next(); };
    await a.engine.sync(); fixture.httpHook = undefined;
    const row = (await a.db.outbox.toArray())[0]!, obj = row.objects[0]!; const original = await a.files.stageRead(obj.stage);
    await unlink(join(a.files.root, ".stage", obj.stage)); await a.files.edit("healthy.md", "still upload");
    const status = await a.engine.sync(); expect(status.errors).toContain("UPLOAD_STAGE_UNAVAILABLE"); await b.engine.sync();
    expect(await b.files.text("healthy.md")).toBe("still upload"); expect(await b.files.text("broken.md")).toBeNull();
    expect((await a.db.outbox.toArray())[0]!.request).toEqual(row.request);
    await writeFile(join(a.files.root, ".stage", obj.stage), original); expect((await a.engine.sync()).errors).toEqual([]); await b.engine.sync();
    expect(await b.files.text("broken.md")).toBe("preserve missing-stage intent");
  });
  it("retries a multi-chunk upload after interruption with the same immutable intent", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; const bytes = new Uint8Array(4 * 1024 * 1024 + 137); bytes.fill(173); bytes[bytes.length - 1] = 29;
    await writeFile(a.files.path("multi.bin"), bytes); const failure = failOnce("after-object-upload"); a.engine.fault = failure.fault; await a.engine.sync();
    expect(failure.hit).toBe(true); const row = (await a.db.outbox.toArray())[0]!; expect(row.objects).toHaveLength(2); const before = await fixture.transport(0).handshake(); expect(before.seq).toBe(0);
    const restarted = await fixture.reopen(0); expect((await restarted.db.outbox.toArray())[0]!.request).toEqual(row.request);
    expect((await restarted.engine.sync()).errors).toEqual([]); expect((await b.engine.sync()).errors).toEqual([]);
    expect(await fingerprint((await b.files.read("multi.bin"))!)).toBe(await fingerprint(bytes)); expect((await fixture.transport(0).snapshot()).revisions).toHaveLength(1);
  });
  it.each(["missing", "corrupt"])("retains the apply journal when its encrypted stage is %s and resumes after repair", async kind => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "remote content"); await a.engine.sync();
    b.engine.fault = failOnce("after-apply-prepare").fault; await b.engine.sync(); const task = (await b.db.applyTasks.toArray())[0]!;
    const original = await b.files.stageRead(task.stage), stage = join(b.files.root, ".stage", task.stage);
    if (kind === "missing") await unlink(stage); else await writeFile(stage, "damaged envelope");
    const restarted = await fixture.reopen(1); const status = await restarted.engine.sync(); expect(status.errors).toContain("APPLY_RECOVERY_FAILED: note.md");
    expect(await restarted.files.text("note.md")).toBeNull(); expect(await restarted.db.applyTasks.count()).toBe(1);
    const p = (await restarted.db.progress.get("progress"))!; expect(p.applied).toBeLessThan(p.received);
    await writeFile(stage, original); expect((await restarted.engine.sync()).errors).toEqual([]); expect(await restarted.files.text("note.md")).toBe("remote content");
  });
  it("refuses acknowledgement if lease ownership changes after the filesystem write", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "exact bytes"); await a.engine.sync();
    const write = b.files.write.bind(b.files);
    b.files.write = async (...args) => { await write(...args); const lease = (await b.db.leases.get("engine"))!; await b.db.leases.put({ ...lease, owner: "other-owner" }); };
    expect((await b.engine.sync()).errors).toContain("LOCAL_LEASE_LOST"); expect(await b.db.localFiles.count()).toBe(0); expect(await b.db.applyTasks.count()).toBe(1);
    b.files.write = write; await b.db.leases.clear(); const restarted = await fixture.reopen(1);
    expect((await restarted.engine.sync()).errors).toEqual([]); expect(await restarted.db.applyTasks.count()).toBe(0); expect(await restarted.files.text("note.md")).toBe("exact bytes");
  });
  it("keeps failed staging out of the outbox and lets healthy files continue", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("first.md", "disk full before intent"); await a.files.edit("second.md", "unrelated bytes"); let failed = false;
    a.files.hook = async op => { if (!failed && op === "stageWrite") { failed = true; throw new Error("INJECTED_ENOSPC"); } };
    const status = await a.engine.sync(); expect(status.errors).toContain("INJECTED_ENOSPC"); await b.engine.sync();
    expect(await b.files.text("first.md")).toBeNull(); expect(await b.files.text("second.md")).toBe("unrelated bytes");
    a.files.hook = undefined; expect((await (await fixture.reopen(0)).engine.sync()).errors).toEqual([]); await b.engine.sync(); expect(await b.files.text("first.md")).toBe("disk full before intent");
  });
  it("recovers an accepted operation even if the receipt and its local upload stage were lost", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "accepted exactly once"); let lost = false;
    fixture.httpHook = async (request, next) => { const response = await next(); if (!lost && request.url.endsWith("/commits") && response.status === 200) { lost = true; throw new Error("INJECTED_LOST_RECEIPT"); } return response; };
    await a.engine.sync(); fixture.httpHook = undefined;
    const row = (await a.db.outbox.toArray())[0]!; await unlink(join(a.files.root, ".stage", row.objects[0]!.stage));
    const before = await fixture.transport(0).handshake(); const restarted = await fixture.reopen(0);
    expect((await restarted.engine.sync()).errors).toEqual([]); expect(await restarted.db.outbox.count()).toBe(0);
    expect((await fixture.transport(0).handshake()).seq).toBe(before.seq);
  });
  it("isolates a failed second absence check so another changed file still uploads", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("unreadable.md", "must not be deleted"); await a.files.edit("healthy.md", "before"); await a.engine.sync(); await b.engine.sync();
    const list = a.files.list.bind(a.files); a.files.list = async () => (await list()).filter(p => p !== "unreadable.md");
    a.files.hook = async (op, path) => { if (op === "read" && path === "unreadable.md") throw new Error("INJECTED_ACCESS_DENIED"); };
    await a.files.edit("healthy.md", "after"); await a.engine.sync(); await b.engine.sync();
    expect(await b.files.text("healthy.md")).toBe("after"); expect(await b.files.text("unreadable.md")).toBe("must not be deleted");
  });
  it("releases the in-memory running gate after a lease-release transaction failure", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "one");
    const transaction = a.db.transaction.bind(a.db); let calls = 0;
    vi.spyOn(a.db, "transaction").mockImplementation(((...args: unknown[]) => {
      if (args[1] === a.db.leases && ++calls === 2) return Promise.reject(new Error("INJECTED_RELEASE_FAILURE"));
      return (transaction as (...args: unknown[]) => unknown)(...args);
    }) as typeof a.db.transaction);
    try { await a.engine.sync(); } catch { /* The original implementation rejects during finally. */ }
    vi.restoreAllMocks(); await a.files.edit("note.md", "two");
    await expect(a.engine.sync()).resolves.toMatchObject({ errors: [] });
  });
  it("releases the running gate after rejecting a manual configuration merge before lease acquisition", async () => {
    const a = fixture.clients[0]!;
    const review = { fileId: "unused", path: ".obsidian/app.json", heads: [], versions: [], location: { revision: "unused", encryptedPath: "unused", pathKey: "unused" } };
    await expect(a.engine.resolve(review, "", undefined, new TextEncoder().encode('{"apiKey":"synthetic-only"}'))).rejects.toThrow("MERGE_CONTAINS_DEVICE_FIELDS");
    await expect(a.engine.sync()).resolves.toMatchObject({ errors: [], state: "complete" });
  });
  it("retains encrypted recovery evidence when a filesystem write tears, while unrelated files continue", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("torn.md", "old exact bytes"); await a.engine.sync(); await b.engine.sync();
    await a.files.edit("torn.md", "new complete bytes"); await a.files.edit("healthy.md", "unrelated complete"); await a.engine.sync();
    let torn = false;
    b.files.hook = async (op, path) => { if (!torn && op === "write" && path === "torn.md") { torn = true; await writeFile(b.files.path(path), "partial"); throw new Error("INJECTED_TORN_WRITE"); } };
    await b.engine.sync(); b.files.hook = undefined; const reopened = await fixture.reopen(1); const status = await reopened.engine.sync();
    expect(await reopened.files.text("torn.md")).toBe("partial"); expect(await reopened.files.text("healthy.md")).toBe("unrelated complete");
    expect(status.state).toBe("needs-attention"); const task = (await reopened.db.applyTasks.toArray()).find(t => t.targetPath === "torn.md")!;
    expect(task.backup).toBeDefined(); expect(await readFile(join(reopened.files.root, ".stage", task.backup!), "utf8")).not.toContain("old exact bytes");
    expect(new Set(await reopened.files.stageList())).toEqual(new Set([task.stage, task.backup]));
  });
  it("keeps journal and backup when a host silently writes partial bytes but reports success", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("note.md", "old protected bytes"); await a.engine.sync(); await b.engine.sync();
    await a.files.edit("note.md", "new complete bytes"); await a.files.edit("healthy.md", "unrelated complete"); await a.engine.sync();
    const write = b.files.write.bind(b.files);
    b.files.write = async (path, ...args) => {
      if (path === "note.md") { await writeFile(b.files.path(path), "partial"); return; }
      await write(path, ...args);
    };
    expect((await b.engine.sync()).errors).toContain("APPLY_VERIFY_FAILED");
    expect(await b.files.text("healthy.md")).toBe("unrelated complete");
    const task = (await b.db.applyTasks.toArray())[0]!;
    expect(task.backup).toBeDefined(); expect(new Set(await b.files.stageList())).toEqual(new Set([task.stage, task.backup]));
    const progress = (await b.db.progress.get("progress"))!; expect(progress.applied).toBeLessThan(progress.received);
    b.files.write = write; await b.files.edit("note.md", "old protected bytes");
    expect((await (await fixture.reopen(1)).engine.sync()).errors).toEqual([]);
    expect(await b.files.text("note.md")).toBe("new complete bytes"); expect(await b.files.stageList()).toEqual([]);
  });
  it("keeps durable server state after a real server SIGKILL and reconnects without duplicate acceptance", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "server restart proof"); await a.engine.sync();
    const before = await fixture.transport(0).handshake(); await fixture.killServer(); await fixture.startServer(true);
    const after = await fixture.transport(0).handshake(); expect(after.epoch).toBe(before.epoch); expect(after.seq).toBe(before.seq);
    expect((await fixture.clients[1]!.engine.sync()).errors).toEqual([]); expect(await fixture.clients[1]!.files.text("note.md")).toBe("server restart proof");
  });
  it("refuses corrupted incoming ciphertext without acknowledging bytes as applied", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "authenticated bytes"); await a.engine.sync();
    fixture.httpHook = async (request, next) => { const response = await next(); if (request.method === "GET" && request.url.includes("/objects/")) { response.bytes = response.bytes.slice(); response.bytes[0]! ^= 1; } return response; };
    const status = await b.engine.sync(); expect(status.errors.length).toBeGreaterThan(0); expect(await b.files.text("note.md")).toBeNull();
    const p = (await b.db.progress.get("progress"))!; expect(p.received).toBeGreaterThan(p.applied);
    fixture.httpHook = undefined; expect((await (await fixture.reopen(1)).engine.sync()).errors).toEqual([]);
    expect(await b.files.text("note.md")).toBe("authenticated bytes"); expect(await fingerprint(new TextEncoder().encode("authenticated bytes"))).toHaveLength(64);
  });
});
