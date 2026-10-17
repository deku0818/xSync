import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it } from "vitest";
import type { Revision, Action } from "../../protocol/src/types";
import { SyncDB, type Outbox } from "../../plugin/src/sync/store";
import { pruneLocalMetadata } from "../../plugin/src/sync/metadata-cleanup";
import { randomId } from "../../plugin/src/sync/crypto";

let db: SyncDB;
const location = { revision: "L", pathKey: "0".repeat(64), encryptedPath: "fixture" };
const payload = { kind: "file" as const, keyEpoch: 1, encryptedManifest: "fixture", objects: [] };
const pending = (opId: string, actions: Action[]): Outbox => ({ opId, request: { protocol: 0, vaultId: "V", epoch: "E", requiredFeatures: [], deviceId: "D", opId, actions }, objects: [] });
const prune = () => db.transaction("rw", db.tables, () => pruneLocalMetadata(db));
beforeEach(async () => {
  db = new SyncDB(`metadata-cleanup-${randomId()}`); await db.open();
  const revisions: Revision[] = Array.from({ length: 200 }, (_, i) => ({ id: `R${i}`, fileId: "F", parents: i ? [`R${i-1}`] : [], deviceId: "D", payload }));
  await db.revisions.bulkPut(revisions);
  await db.baseProofs.bulkPut(revisions.map(r => ({ id: r.id, proof: { vaultId: "V", epoch: "E", fileId: "F", revisionId: r.id, digest: "0".repeat(64), boundary: 200, token: "1".repeat(64) } })));
  await db.localFiles.put({ id: "F", path: "note.md", location, revision: "R199", fingerprint: "fixture", deleted: false });
  await db.remoteFiles.put({ id: "F", entryKind: "file", location, heads: ["R199"] });
});
afterEach(async () => { await db.delete(); });

it("retains current baselines without recursively retaining authenticated parent strings", async () => {
  await prune(); expect(await db.revisions.toCollection().primaryKeys()).toEqual(["R199"]);
  expect(await db.baseProofs.toCollection().primaryKeys()).toEqual(["R199"]);
  expect((await db.revisions.get("R199"))!.parents).toEqual(["R198"]);
});
it("retains exact excluded, failed, conflict, inbox, migration and archived recovery dependencies", async () => {
  await db.outbox.add({ ...pending("excluded", [{ type: "edit", fileId: "F", revisionId: "R10", displayedRevision: "R9", payload }]), error: "EXCLUDED_BY_RULE" });
  await db.rejectedOutbox.put(pending("rejected", [{ type: "resolve", fileId: "F", revisionId: "R20", observedHeads: ["R18", "R19"], payload, decision: { kind: "select", selectedRevision: "R18" } }]));
  await db.applyTasks.put({ id: "F", revision: "R30", location, stage: randomId(), sourcePath: "note.md", targetPath: "note.md", oldFingerprint: null, desiredFingerprint: "fixture", deleted: false });
  await db.conflicts.put({ id: "F", path: "note.md", heads: ["R40", "R41"], reason: "fixture" });
  await db.inbox.put({ seq: 1, fileIds: ["F"], done: false, change: { seq: 1, deviceId: "D", opId: "incoming", actions: [{ type: "edit", fileId: "F", revisionId: "R50", displayedRevision: "R49", payload }] } });
  await db.metadataMigration.put({ id: "migration", complete: false, requests: [pending("migrate", [{ type: "edit", fileId: "F", revisionId: "R60", displayedRevision: "R59", payload }]).request] });
  await db.reconciliations.put({ id: "archived", reason: "UNKNOWN", local: { id: "archived", path: "old.md", location, revision: "R70", fingerprint: "fixture", deleted: false }, acceptedRevision: "R71", outbox: [], tasks: [] });
  await prune();
  const expected = [9,10,18,19,20,30,40,41,49,50,59,60,70,71,199].map(i => `R${i}`).sort();
  expect((await db.revisions.toCollection().primaryKeys()).sort()).toEqual(expected);
  expect((await db.baseProofs.toCollection().primaryKeys()).sort()).toEqual(expected);
});
it("rolls cache deletion back with the caller's durable dependency transaction", async () => {
  await expect(db.transaction("rw", db.tables, async () => { await pruneLocalMetadata(db); throw new Error("INTERRUPTED"); })).rejects.toThrow("INTERRUPTED");
  expect(await db.revisions.count()).toBe(200); expect(await db.baseProofs.count()).toBe(200);
  await prune(); expect(await db.revisions.count()).toBe(1);
});
