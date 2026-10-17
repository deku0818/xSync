import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RecoveryFixture, type RecoveryClient } from "./recovery-support";
import { VaultCrypto, fingerprint, randomId } from "../../plugin/src/sync/crypto";
import type { Outbox } from "../../plugin/src/sync/store";

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("metadata compaction with real HTTP/PG and immutable offline migration", () => {
  let fixture: RecoveryFixture;
  afterEach(async () => { await fixture?.close(); });
  async function open(full = false) {
    fixture = new RecoveryFixture(); await fixture.open(false, full ? "full" : undefined);
    await fixture.client(0); await fixture.client(1);
    return fixture.clients as [RecoveryClient, RecoveryClient];
  }
  async function upgrade() {
    await fixture.killServer();
    const path = join(fixture.root, "server.json"), cfg = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...cfg, metadataMode: "compact" }), { mode: 0o600 });
    await fixture.startServer(true);
  }
  async function legacyEdit(a: RecoveryClient, text: string): Promise<Outbox> {
    const local = (await a.db.localFiles.toArray())[0]!, writer = (await a.db.writerState.get("writer"))!;
    const keys = await VaultCrypto.restore(fixture.config.vaultId, a.material.session);
    try {
      const bytes = new TextEncoder().encode(text), object = keys.object(bytes); await a.files.stageWrite(object.id, object.bytes);
      const base = { id: randomId(), fileId: local.id, parents: [local.revision], deviceId: a.engine.deviceId };
      const revision = { ...base, payload: await keys.payload(base, bytes, "file", [object.id]) };
      const capturedFingerprint = await fingerprint(bytes);
      const opId = randomId(), row: Outbox = { opId, coordinate: { stream: writer.stream, number: writer.next++ }, objects: [{ id: object.id, stage: object.id }],
        request: { protocol: 0, vaultId: fixture.config.vaultId, epoch: fixture.config.epoch, requiredFeatures: ["causal-heads", "atomic-groups"], deviceId: a.engine.deviceId, opId,
          actions: [{ type: "edit", fileId: local.id, revisionId: base.id, displayedRevision: local.revision, payload: revision.payload }] } };
      await a.db.transaction("rw", [a.db.localFiles, a.db.revisions, a.db.outbox, a.db.writerState], async () => {
        await a.db.localFiles.put({ ...local, revision: base.id, fingerprint: capturedFingerprint });
        await a.db.revisions.put(revision); await a.db.outbox.add(row); await a.db.writerState.put(writer);
      });
      await a.files.edit(local.path, text); return row;
    } finally { keys.close(); }
  }

  it("bounds settled caches and main server metadata across repeated edits, then accepts a genuinely pruned offline base", async () => {
    const [a,b] = await open(); await a.files.edit("note.md", "shared baseline"); await a.engine.sync(); await b.engine.sync();
    const base = (await b.db.localFiles.toArray())[0]!;
    for (let i = 0; i < 12; i++) { await a.files.edit("note.md", `online ${i}`); expect((await a.engine.sync()).errors).toEqual([]); expect(await a.db.revisions.count()).toBe(1); expect(await a.db.baseProofs.count()).toBe(1); }
    await fixture.retireLogs();
    await fixture.sql(`DO $$ BEGIN IF (SELECT count(*) FROM ${fixture.schema}.revisions) <> 1 OR (SELECT count(*) FROM ${fixture.schema}.operations) <> 0 OR (SELECT count(*) FROM ${fixture.schema}.legacy_revisions) <> 0 THEN RAISE EXCEPTION 'metadata not bounded'; END IF; END $$`);
    await b.files.edit("note.md", "offline from removed parent"); expect((await b.engine.sync()).errors).toEqual([]);
    const review = await b.engine.review(base.id); expect(review.versions.map(v => v.text).sort()).toEqual(["offline from removed parent", "online 11"]);
    await b.engine.resolve(review, review.versions.find(v => v.text === "offline from removed parent")!.revision);
    await a.engine.sync(); await fixture.retireLogs();
    expect(await a.files.text("note.md")).toBe("offline from removed parent"); expect(await a.db.revisions.count()).toBe(1);
    const remote = fixture.transport(0), snapshot = await remote.snapshot(); expect(snapshot.revisions).toHaveLength(1); expect(snapshot.bases).toHaveLength(1); await remote.releaseSnapshots();
  }, 30000);

  it("registers a real pre-upgrade random-ID outbox without recapturing it from newer disk bytes", async () => {
    const [a,b] = await open(true); await a.files.edit("note.md", "original baseline"); await a.engine.sync(); await b.engine.sync();
    const old = await legacyEdit(a, "captured legacy bytes"); await a.files.edit("note.md", "later unsent A bytes");
    await b.files.edit("note.md", "concurrent B bytes"); await b.engine.sync(); await upgrade(); await fixture.retireLogs();
    const sent: unknown[] = [];
    fixture.httpHook = async (request,next) => { if (request.url.endsWith("/metadata/commits")) sent.push(JSON.parse(new TextDecoder().decode(request.body)).request); return next(); };
    const status = await a.engine.sync(); expect(status.errors).toEqual([]); expect(status.conflicts).toBe(1); expect(sent).toContainEqual(old.request);
    expect((await a.db.metadataMigration.get("migration"))!).toMatchObject({ complete: true, requests: [] });
    const review = await a.engine.review((await a.db.localFiles.toArray())[0]!.id);
    expect(review.versions.map(v => v.text).sort()).toEqual(["concurrent B bytes", "later unsent A bytes"]);
  }, 30000);

  it("retries the same persisted migration bundle after registration commits but the response is lost", async () => {
    const [a] = await open(true); await a.files.edit("note.md", "baseline"); await a.engine.sync(); const row = await legacyEdit(a, "pending old bytes"); await upgrade();
    let lose = true;
    fixture.httpHook = async (request,next) => { const response = await next(); if (lose && request.url.endsWith("/metadata/migrate") && response.status === 200) { lose = false; throw new Error("LOST_MIGRATION_RESPONSE"); } return response; };
    expect((await a.engine.sync()).errors).toContain("LOST_MIGRATION_RESPONSE");
    expect((await a.db.metadataMigration.get("migration"))?.requests).toEqual([row.request]);
    fixture.httpHook = undefined; const restored = await fixture.reopen(0);
    expect((await restored.engine.sync()).errors).toEqual([]); expect(await restored.files.text("note.md")).toBe("pending old bytes");
    expect((await fixture.transport(0).handshake()).seq).toBe(2);
  });

  it("preserves an unregistered old intent for reconciliation instead of guessing a new parent or request", async () => {
    const [a] = await open(); await a.files.edit("note.md", "baseline"); await a.engine.sync(); const row = await legacyEdit(a, "unregistered bytes");
    expect((await a.engine.sync()).errors).toContain("LEGACY_INTENT_UNREGISTERED");
    expect((await a.db.outbox.toArray())[0]!.request).toEqual(row.request); expect(await a.files.text("note.md")).toBe("unregistered bytes");
    expect((await a.files.stageList()).includes(row.objects[0]!.stage)).toBe(true);
    expect((await fixture.transport(0).handshake()).seq).toBe(1);
  });
});
