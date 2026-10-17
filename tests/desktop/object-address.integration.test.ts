import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RecoveryFixture, type RecoveryClient } from "./recovery-support";
import { VaultCrypto, fingerprint, randomId } from "../../plugin/src/sync/crypto";
import { derivedID, derivedOperation } from "../../protocol/src/metadata";
import { SYNC_FEATURES } from "../../protocol/src/wire";
import { OBJECT_CAPABILITY } from "../../protocol/src/objects";
import type { Outbox } from "../../plugin/src/sync/store";
import { legacyObject } from "./legacy-object-fixture";

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("addressed identity retirement and genuine v0 compatibility with real HTTP/PG", () => {
  let fixture: RecoveryFixture;
  afterEach(async () => { await fixture?.close(); });
  async function open(full = false) {
    fixture = new RecoveryFixture(); await fixture.open(false, full ? "full" : undefined);
    await fixture.client(0); await fixture.client(1);
    return fixture.clients as [RecoveryClient, RecoveryClient];
  }
  async function upgrade() {
    await fixture.killServer(); const path = join(fixture.root, "server.json"), cfg = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...cfg, metadataMode: "compact" }), { mode: 0o600 }); await fixture.startServer(true);
  }
  async function queueV0(a: RecoveryClient, text: string): Promise<Outbox> {
    const local = await a.db.localFiles.where("path").equals("note.md").first(), writer = (await a.db.writerState.get("writer"))!;
    const coordinate = { stream: writer.stream, number: writer.next++ }, keys = await VaultCrypto.restore(fixture.config.vaultId, a.material.session);
    try {
      const bytes = new TextEncoder().encode(text), object = await legacyObject(a.material.session, bytes);
      await a.files.stageWrite(object.id, object.bytes);
      const fileId = local?.id ?? randomId(), revisionId = derivedID(coordinate, "r"), parents = local ? [local.revision] : [];
      const base = { id: revisionId, fileId, parents, deviceId: a.engine.deviceId }, payload = await keys.payload(base, bytes, "file", [object.id]);
      const location = local?.location ?? keys.location(fileId, "note.md", derivedID(coordinate, "l"));
      const capturedFingerprint = await fingerprint(bytes), opId = derivedOperation(coordinate);
      const row: Outbox = { opId, coordinate, objects: [{ id: object.id, stage: object.id }], request: { protocol: 0, vaultId: fixture.config.vaultId, epoch: fixture.config.epoch, deviceId: a.engine.deviceId, opId,
        requiredFeatures: SYNC_FEATURES.filter(value => value !== OBJECT_CAPABILITY), actions: [local
          ? { type: "edit", fileId, revisionId, displayedRevision: local.revision, payload }
          : { type: "create", fileId, revisionId, location, payload }] } };
      await a.db.transaction("rw", [a.db.localFiles, a.db.revisions, a.db.outbox, a.db.writerState], async () => {
        await a.db.localFiles.put({ id: fileId, path: "note.md", location, revision: revisionId, fingerprint: capturedFingerprint, deleted: false });
        await a.db.revisions.put({ ...base, payload }); await a.db.outbox.add(row); await a.db.writerState.put(writer);
      });
      await a.files.edit("note.md", text); return row;
    } finally { keys.close(); }
  }

  it("keeps only live addressed object identities across repeated completed edits", async () => {
    const [a] = await open();
    for (let i = 0; i < 8; i++) {
      await a.files.edit("note.md", `settled content ${i}`); expect((await a.engine.sync()).errors).toEqual([]);
      await fixture.collectExpired(); await fixture.retireLogs();
      await fixture.sql(`DO $$ BEGIN IF (SELECT count(*) FROM ${fixture.schema}.objects) <> 1 OR (SELECT count(*) FROM ${fixture.schema}.revision_objects) <> 1 THEN RAISE EXCEPTION 'identity growth'; END IF; END $$`);
      expect(await readdir(join(fixture.root, "objects", fixture.config.vaultId))).toHaveLength(1);
    }
    expect(await a.files.stageList()).toEqual([]);
  }, 30000);

  it("migrates a v0 queue even when 3B registration was already closed, preserving captured bytes", async () => {
    const [a,b] = await open(true); await a.engine.sync(); await upgrade();
    // This is the v6 checkpoint at the boundary before object migration existed.
    await fixture.transport(0).registerLegacy([]); await a.db.metadataMigration.put({ id: "migration", complete: true, requests: [] });
    await a.db.progress.update("progress", { checkpoint: 0 });
    const old = await queueV0(a, "captured v0 bytes"); await a.files.edit("note.md", "newer disk bytes");
    const submitted: unknown[] = [];
    fixture.httpHook = async (request,next) => { if (request.url.endsWith("/metadata/commits")) submitted.push(JSON.parse(new TextDecoder().decode(request.body)).request); return next(); };
    expect((await a.engine.sync()).errors).toEqual([]); expect(submitted).toContainEqual(old.request);
    expect(await a.db.metadataMigration.get("objects")).toMatchObject({ complete: true, requests: [] });
    expect((await b.engine.sync()).errors).toEqual([]); expect(await b.files.text("note.md")).toBe("newer disk bytes");
    await fixture.collectExpired();
    await fixture.sql(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM ${fixture.schema}.objects WHERE id='${old.objects[0]!.id}' AND state='deleted') THEN RAISE EXCEPTION 'legacy evidence missing'; END IF; END $$`);
  });

  it("reads genuine v0 content, then preserves both offline edits after its ciphertext is retired", async () => {
    const [a,b] = await open(true); await a.engine.sync(); const old = await queueV0(a, "v0 common baseline");
    expect((await a.engine.sync()).errors).toEqual([]); expect((await b.engine.sync()).errors).toEqual([]);
    expect(await b.files.text("note.md")).toBe("v0 common baseline");
    await upgrade(); await b.files.edit("note.md", "B offline from v0"); await a.files.edit("note.md", "A current v1");
    expect((await a.engine.sync()).errors).toEqual([]); await fixture.collectExpired(); await fixture.retireLogs();
    await fixture.sql(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM ${fixture.schema}.objects WHERE id='${old.objects[0]!.id}' AND state='deleted') THEN RAISE EXCEPTION 'old identity changed'; END IF; END $$`);
    expect((await b.engine.sync()).conflicts).toBe(1);
    const review = await b.engine.review((await b.db.localFiles.toArray())[0]!.id);
    expect(review.versions.map(v => v.text).sort()).toEqual(["A current v1", "B offline from v0"]);
    expect(await b.files.text("note.md")).toBe("B offline from v0");
  });

  it("retries the exact persisted object migration bundle after its committed response is lost", async () => {
    const [a] = await open(true); await a.engine.sync(); const old = await queueV0(a, "pending old object"); await upgrade();
    let lose = true;
    fixture.httpHook = async (request,next) => { const response = await next(); if (lose && request.url.endsWith("/content/migrate") && response.status === 200) { lose = false; throw new Error("LOST_OBJECT_REGISTRATION"); } return response; };
    expect((await a.engine.sync()).errors).toContain("LOST_OBJECT_REGISTRATION");
    expect((await a.db.metadataMigration.get("objects"))?.requests).toEqual([old.request]);
    fixture.httpHook = undefined; const restored = await fixture.reopen(0);
    expect((await restored.engine.sync()).errors).toEqual([]); expect(await restored.files.text("note.md")).toBe("pending old object");
    expect((await fixture.transport(0).handshake()).seq).toBe(1);
  });

  it("preserves an unregistered v0 intent and permits unrelated v1 files to sync", async () => {
    const [a,b] = await open(); await a.engine.sync(); const old = await queueV0(a, "unregistered v0 bytes"); await a.files.edit("healthy.md", "v1 continues");
    expect((await a.engine.sync()).errors).toContain("LEGACY_OBJECT_UNREGISTERED");
    expect((await a.db.outbox.toArray())[0]!.request).toEqual(old.request); expect(await a.files.text("note.md")).toBe("unregistered v0 bytes");
    expect((await a.files.stageList()).includes(old.objects[0]!.stage)).toBe(true);
    expect((await b.engine.sync()).errors).toEqual([]); expect(await b.files.text("healthy.md")).toBe("v1 continues");
  });
});
