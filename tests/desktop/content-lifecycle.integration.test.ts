import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { readdir, unlink, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RecoveryFixture } from "./recovery-support";
import { RemoteError } from "../../plugin/src/sync/transport";

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("content retirement with real server/PG/files and maintenance SIGKILL", () => {
  let fixture: RecoveryFixture;
  beforeEach(async () => { fixture = new RecoveryFixture(); await fixture.open(); await fixture.client(0); await fixture.client(1); }, 20000);
  afterEach(async () => { await fixture?.close(); });
  const objects = () => readdir(join(fixture.root, "objects", fixture.config.vaultId));
  const contains = (names: string[], id: string) => names.some(name => name === id || name.startsWith(id + ".g") || name.startsWith(id + ".s"));

  it("keeps manual maintenance non-destructive when configured for dry-run", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "old content"); await a.engine.sync();
    const local = (await a.db.localFiles.toArray())[0]!; const oldID = (await a.db.revisions.get(local.revision))!.payload.objects[0]!;
    await a.files.edit("note.md", "current content"); await a.engine.sync(); await fixture.collect();
    await fixture.sql(`UPDATE ${fixture.schema}.objects SET unreferenced_at=clock_timestamp()-interval '2 hours' WHERE state='candidate'`);
    const path = join(fixture.root, "server.json"), cfg = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...cfg, cleanupMode: "dry-run" }), { mode: 0o600 });
    await fixture.collect(); expect(contains(await objects(), oldID)).toBe(true);
    await writeFile(path, JSON.stringify(cfg), { mode: 0o600 });
    await fixture.collect(); expect(contains(await objects(), oldID)).toBe(false);
  });

  it("really deletes old ciphertext and logs while preserving an immutable queued offline edit", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("note.md", "common original"); await a.engine.sync(); await b.engine.sync();
    const local = (await b.db.localFiles.toArray())[0]!;
    const oldIDs = (await b.db.revisions.get(local.revision))!.payload.objects;
    await b.files.edit("note.md", "B queued offline");
    fixture.httpHook = async (request, next) => { if (request.method === "PUT") throw new Error("OFFLINE"); return next(); };
    await b.engine.sync(); const original = (await b.db.outbox.toArray())[0]!.request;
    fixture.httpHook = undefined;
    await a.files.edit("note.md", "A concurrent new"); await a.engine.sync();
    await fixture.collectExpired(); await fixture.retireLogs();
    const remaining = await objects(); expect(oldIDs.every(id => !contains(remaining, id))).toBe(true);
    await expect(fixture.transport(1).changes(fixture.config.epoch, 0)).rejects.toThrow("NEED_SNAPSHOT");
    const committed: unknown[] = [];
    fixture.httpHook = async (request, next) => { if (request.url.endsWith("/commits")) committed.push(((v) => v.request ?? v)(JSON.parse(new TextDecoder().decode(request.body)))); return next(); };
    expect((await b.engine.sync()).conflicts).toBe(1); expect(committed).toContainEqual(original);
    const review = await b.engine.review((await b.db.conflicts.toArray())[0]!.id);
    expect(review.versions.map(row => row.text).sort()).toEqual(["A concurrent new", "B queued offline"]);
    expect(await b.files.text("note.md")).toBe("B queued offline");
  });

  it("refreshes an expired download view without overwriting local work or hiding corruption", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await b.engine.sync(); await a.files.edit("note.md", "old download view"); await a.engine.sync();
    let race = true;
    fixture.httpHook = async (request, next) => {
      if (race && request.url.endsWith("/content/read")) {
        race = false; await a.files.edit("note.md", "fresh download view"); await a.engine.sync(); await fixture.collectExpired();
      }
      return next();
    };
    expect((await b.engine.sync()).errors).toEqual([]); expect(race).toBe(false);
    expect(await b.files.text("note.md")).toBe("fresh download view"); expect(await b.db.outbox.count()).toBe(0);
  });

  it("reuploads expired uncommitted ciphertext using the same IDs and unchanged operation", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "pending exact bytes");
    a.engine.fault = point => { if (point === "after-object-upload") throw new Error("STOP_BEFORE_COMMIT"); };
    expect((await a.engine.sync()).errors).toContain("STOP_BEFORE_COMMIT");
    const original = (await a.db.outbox.toArray())[0]!; expect((await objects()).length).toBeGreaterThan(0);
    await fixture.collectExpired(); expect(await objects()).toEqual([]);
    a.engine.fault = undefined; expect((await a.engine.sync()).errors).toEqual([]);
    expect((await objects()).some(name => name.startsWith(original.objects[0]!.id + ".s"))).toBe(true);
    expect((await fixture.transport(0).handshake()).seq).toBe(1);
  });

  it("returns the original receipt for a legacy queued request after both its remote and local old ciphertext disappear", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "original accepted bytes");
    fixture.httpHook = async (request, next) => { if (request.method === "PUT") throw new Error("QUEUE_ONLY"); return next(); };
    await a.engine.sync(); fixture.httpHook = undefined;
    const row = (await a.db.outbox.toArray())[0]!;
    row.request.requiredFeatures = row.request.requiredFeatures.filter(value => value !== "content-leases-v1");
    await a.db.outbox.put(row);
    let lose = true;
    fixture.httpHook = async (request, next) => { const r = await next(); if (lose && request.url.endsWith("/commits") && r.status === 200) { lose = false; throw new Error("LOST_RECEIPT"); } return r; };
    expect((await a.engine.sync()).errors).toContain("LOST_RECEIPT"); fixture.httpHook = undefined;
    await b.engine.sync(); await b.files.edit("note.md", "new B content"); await b.engine.sync(); await fixture.collectExpired();
    await unlink(join(a.files.root, ".stage", row.objects[0]!.stage));
    const before = await fixture.transport(0).handshake(); const requests: unknown[] = [];
    fixture.httpHook = async (request, next) => { if (request.url.endsWith("/commits")) requests.push(((v) => v.request ?? v)(JSON.parse(new TextDecoder().decode(request.body)))); return next(); };
    expect((await a.engine.sync()).errors).toEqual([]); expect(requests).toContainEqual(row.request);
    expect(await a.files.text("note.md")).toBe("new B content"); expect((await fixture.transport(0).handshake()).seq).toBe(before.seq);
  });

  it("expires snapshot/read protections without treating them as permanent history", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "snapshot protected"); await a.engine.sync();
    const transport = fixture.transport(0); const snapshot = await transport.snapshot();
    const id = snapshot.revisions.find(row => row.id === snapshot.files[0]!.heads[0])!.payload.objects[0]!;
    await a.files.edit("note.md", "replacement"); await a.engine.sync(); await fixture.collectExpired(); expect(contains(await objects(), id)).toBe(true);
    await fixture.sql(`UPDATE ${fixture.schema}.content_leases SET expires_at=clock_timestamp()-interval '1 second'`);
    await expect(transport.readLease(snapshot.files[0]!.heads[0]!)).rejects.toBeInstanceOf(RemoteError);
    await fixture.collectExpired(); expect(contains(await objects(), id)).toBe(false);
    await transport.releaseSnapshots();
  });

  it.each(["before-object-identity-retire", "after-object-identity-retire", "before-metadata-cleanup-commit", "after-metadata-cleanup-commit", "before-gc-claim", "after-gc-claim", "before-gc-unlink", "after-gc-unlink", "before-gc-confirm", "after-gc-confirm"])("recovers an actual maintenance process SIGKILL at %s", async point => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit("note.md", "old content"); await a.engine.sync(); await b.engine.sync();
    const local = (await a.db.localFiles.toArray())[0]!; const oldID = (await a.db.revisions.get(local.revision))!.payload.objects[0]!;
    await a.files.edit("note.md", "current survives"); await a.engine.sync(); await fixture.collect();
    await fixture.sql(`UPDATE ${fixture.schema}.objects SET unreferenced_at=clock_timestamp()-interval '2 hours' WHERE state='candidate'`);
    await fixture.collect(point); await fixture.collectExpired();
    expect(contains(await objects(), oldID)).toBe(false);
    expect((await b.engine.sync()).errors).toEqual([]); expect(await b.files.text("note.md")).toBe("current survives");
  });
});
