import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Action, Revision } from "../../protocol/src/types";
import { cleanupLocalData, type StageCleanupPort } from "../../plugin/src/sync/local-cleanup";
import { SyncDB, type ApplyTask, type Outbox, type Reconciliation } from "../../plugin/src/sync/store";
import { VaultCrypto, randomId } from "../../plugin/src/sync/crypto";

describe("completed local data cleanup", () => {
  let db: SyncDB, keys: VaultCrypto;
  let stages: Set<string>, removed: string[];
  const owner = "cleanup-owner", deviceId = "device";
  let files: StageCleanupPort;
  const assertLease = async () => {
    const lease = await db.leases.get("engine");
    if (lease?.owner !== owner || lease.until <= Date.now()) throw new Error("LOCAL_LEASE_LOST");
  };
  const context = () => ({ assertLease, manifestFingerprint: (r: Revision) => keys.manifest(r).fingerprint });
  const stage = () => { const id = randomId(); stages.add(id); return id; };
  const revision = async (fileId: string, text: string, parents: string[] = [], objects: string[] = []): Promise<Revision> => {
    const base = { id: randomId(), fileId, deviceId, parents };
    const r = { ...base, payload: await keys.payload(base, new TextEncoder().encode(text), "file", objects) };
    await db.revisions.put(r); return r;
  };
  const outbox = (fileId: string, id: string, actions?: Action[]): Outbox => {
    const opId = randomId();
    return { opId, request: { protocol: 0, vaultId: "vault", epoch: "epoch", deviceId, opId, requiredFeatures: [],
      actions: actions ?? [{ type: "branch", fileId, revisionId: randomId(), payload: { kind: "file", keyEpoch: 1, encryptedManifest: "test", objects: [id] } }] },
    objects: [{ id, stage: id }],
    };
  };
  const task = (id: string, snapshot: string, backup?: string): ApplyTask => ({
    id, stage: snapshot, backup, sourcePath: "note.md", targetPath: "note.md", oldFingerprint: null,
    desiredFingerprint: "test", revision: "test", location: keys.location(id, "note.md"), deleted: false,
  });
  beforeEach(async () => {
    db = new SyncDB(`cleanup-${randomId()}`); await db.open();
    keys = (await VaultCrypto.create("vault", "synthetic-cleanup-test")).crypto;
    await db.leases.put({ id: "engine", owner, until: Date.now() + 60000 });
    await db.progress.put({ id: "progress", vaultId: "vault", epoch: "epoch", received: 4, applied: 2 });
    stages = new Set(); removed = [];
    files = { stageList: async () => [...stages], stageRemove: async id => { stages.delete(id); removed.push(id); } };
  });
  afterEach(async () => { keys.close(); await db.delete(); });

  it("compacts completed inbox runs while retaining unfinished groups and their completion endpoint", async () => {
    await db.inbox.bulkPut([1, 2, 3, 4].map(seq => ({ seq, fileIds: [], done: seq !== 2 })));
    await cleanupLocalData(db, files, context());
    expect((await db.inbox.toArray()).map(row => row.seq)).toEqual([2, 4]);
    expect((await db.progress.get("progress"))?.applied).toBe(2);
  });

  it("preserves excluded uploads, failed journals, rejection evidence, archives, conflicts and pending inbox dependencies", async () => {
    const upload = stage(), desired = stage(), backup = stage(), rejected = stage(), archived = stage();
    const conflict = stage(), incoming = stage(), completed = stage(), orphan = stage();
    await db.outbox.add({ ...outbox("upload", upload), error: "EXCLUDED_BY_RULE" });
    await db.applyTasks.put(task("failed-apply", desired, backup));
    await db.rejectedOutbox.put({ ...outbox("rejected", rejected), error: "REVIEW_STALE" });
    const r = await revision("conflict", "conflict bytes", [], [conflict]);
    await db.conflicts.put({ id: "conflict", path: "conflict.md", heads: [r.id], reason: "CONCURRENT_REVISIONS" });
    await db.mergeDrafts.put({ id: "conflict", ciphertext: new Uint8Array([1, 2]) });
    await db.reconciliations.put({ id: "archive", reason: "UNKNOWN", local: {
      id: "archive", revision: "missing", fingerprint: "unknown", deleted: false, path: "archive.md", location: keys.location("archive", "archive.md"),
    }, outbox: [], tasks: [task("archive", archived)] });
    const incomingRow = outbox("incoming", incoming), completedRow = outbox("completed", completed);
    await db.inbox.bulkPut([
      { seq: 1, fileIds: ["completed"], done: true, change: { seq: 1, deviceId, opId: completedRow.opId, actions: completedRow.request.actions } },
      { seq: 3, fileIds: ["incoming"], done: false, change: { seq: 3, deviceId, opId: incomingRow.opId, actions: incomingRow.request.actions } },
    ]);
    await cleanupLocalData(db, files, context());
    expect(new Set(removed)).toEqual(new Set([completed, orphan]));
    expect(stages).toEqual(new Set([upload, desired, backup, rejected, archived, conflict, incoming]));
    expect(await db.mergeDrafts.count()).toBe(1); expect(await db.revisions.count()).toBe(1);
  });

  it("keeps a stage shared by completed and pending work until the last durable dependency ends", async () => {
    const shared = stage(); const row = outbox("pending", shared); await db.outbox.add(row);
    await db.inbox.put({ seq: 1, fileIds: [], done: true });
    await cleanupLocalData(db, files, context()); expect(stages.has(shared)).toBe(true);
    await db.outbox.clear(); await cleanupLocalData(db, files, context()); expect(stages.has(shared)).toBe(false);
  });
  it("protects reused object stages in pending keep-both selections even without new upload objects", async () => {
    const selected = stage(), companion = stage(), orphan = stage();
    const payload = (id: string) => ({ kind: "file" as const, keyEpoch: 1, encryptedManifest: "test", objects: [id] });
    const row = outbox("original", selected, [{ type: "resolve", fileId: "original", revisionId: "resolution",
      observedHeads: ["A", "B"], payload: payload(selected), decision: { kind: "keep-both", selectedRevision: "A", companionSource: "B",
        companion: { type: "create", fileId: "companion", revisionId: "copy", location: keys.location("companion", "copy.md"), payload: payload(companion) } } }]);
    row.objects = []; await db.outbox.add(row);
    await cleanupLocalData(db, files, context());
    expect(stages).toEqual(new Set([selected, companion])); expect(removed).toEqual([orphan]);
  });

  it.each(["before-local-cleanup-commit", "after-local-cleanup-commit", "before-stage-remove", "after-stage-remove"])("safely retries interruption at %s", async point => {
    const protectedId = stage(); await db.applyTasks.put(task("pending", protectedId));
    const garbage = [stage(), stage()]; await db.inbox.put({ seq: 1, fileIds: [], done: true });
    await expect(cleanupLocalData(db, files, { ...context(), fault: current => {
      if (current === point) throw new Error("INJECTED_CLEANUP_INTERRUPTION");
    } })).rejects.toThrow("INJECTED_CLEANUP_INTERRUPTION");
    expect(await db.inbox.count()).toBe(point === "before-local-cleanup-commit" ? 1 : 0);
    expect(stages.has(protectedId)).toBe(true);
    await cleanupLocalData(db, files, context());
    expect(stages).toEqual(new Set([protectedId])); expect(garbage.every(id => removed.includes(id))).toBe(true);
  });

  it("retains remaining stages after an I/O deletion failure and retries without restoring completed records", async () => {
    stage(); stage(); await db.inbox.put({ seq: 1, fileIds: [], done: true });
    const remove = files.stageRemove; let fail = true;
    files.stageRemove = async id => { if (fail) { fail = false; throw new Error("ACCESS_DENIED"); } await remove(id); };
    await expect(cleanupLocalData(db, files, context())).rejects.toThrow("ACCESS_DENIED");
    expect(stages.size).toBe(2); expect(await db.inbox.count()).toBe(0);
    await cleanupLocalData(db, files, context()); expect(stages.size).toBe(0);
  });

  it.each(["expired", "stolen"])("does not mutate metadata or files if the lease is %s during enumeration", async kind => {
    stage(); await db.inbox.put({ seq: 1, fileIds: [], done: true });
    files.stageList = async () => {
      await db.leases.put({ id: "engine", owner: kind === "stolen" ? "other" : owner, until: kind === "expired" ? 0 : Date.now() + 60000 });
      return [...stages];
    };
    await expect(cleanupLocalData(db, files, context())).rejects.toThrow("LOCAL_LEASE_LOST");
    expect(removed).toEqual([]); expect(await db.inbox.count()).toBe(1);
  });

  it("stops deletion when ownership changes between candidates", async () => {
    stage(); stage(); const remove = files.stageRemove;
    files.stageRemove = async id => { await remove(id); await db.leases.put({ id: "engine", owner: "other", until: Date.now() + 60000 }); };
    await expect(cleanupLocalData(db, files, context())).rejects.toThrow("LOCAL_LEASE_LOST");
    expect(removed).toHaveLength(1); expect(stages.size).toBe(1);
  });

  it("never includes a later writer's stages in the enumerated candidate set", async () => {
    const old = stage(); let newer = "";
    files.stageList = async () => { const list = [...stages]; newer = stage(); return [...list, "../outside", "not-a-stage"]; };
    await cleanupLocalData(db, files, context());
    expect(removed).toEqual([old]); expect(stages.has(newer)).toBe(true);
  });

  const collision = async () => {
    const object = stage(), original = await revision("old", "independent bytes", [], [object]);
    const location = keys.location("old", "note.md");
    const intent = outbox("old", object, [{ type: "create", fileId: "old", revisionId: original.id, payload: original.payload, location }]);
    const archive: Reconciliation = { id: "old", reason: "INITIAL_PATH_COLLISION", replacementFileId: "replacement", tasks: [], outbox: [intent],
      local: { id: "old", path: "note.md", location, revision: original.id, deleted: false, fingerprint: keys.manifest(original).fingerprint } };
    await db.reconciliations.put(archive); await db.rejectedOutbox.put({ ...intent, error: "INITIAL_PATH_COLLISION" });
    const imported = await revision("replacement", "independent bytes");
    const resolved = await revision("replacement", "explicit final result", [imported.id]);
    await db.remoteFiles.put({ id: "replacement", entryKind: "file", location: keys.location("replacement", "renamed.md"), heads: [resolved.id] });
    return { archive, object, imported, resolved };
  };
  it("releases an initialization archive only when its exact bytes have accepted ancestry, including after rename/resolution", async () => {
    const { object } = await collision();
    await cleanupLocalData(db, files, context());
    expect(await db.reconciliations.count()).toBe(0); expect(await db.rejectedOutbox.count()).toBe(0);
    expect(stages.has(object)).toBe(false); expect(await db.revisions.count()).toBe(3);
  });
  it("releases legacy archives after adopting identical content already accepted from another device", async () => {
    const { archive, object } = await collision();
    delete archive.replacementFileId; await db.reconciliations.put(archive);
    const base = { id: randomId(), fileId: "replacement", parents: [], deviceId: "other-device" };
    const adopted = { ...base, payload: await keys.payload(base, new TextEncoder().encode("independent bytes"), "file", []) };
    await db.revisions.put(adopted);
    await db.remoteFiles.update("replacement", { location: keys.location("replacement", archive.local.path), heads: [adopted.id] });
    await cleanupLocalData(db, files, context());
    expect(await db.reconciliations.count()).toBe(0); expect(await db.rejectedOutbox.count()).toBe(0); expect(stages.has(object)).toBe(false);
  });

  it("does not treat a matching unsubmitted local revision as accepted evidence", async () => {
    const { object } = await collision();
    const accepted = await revision("replacement", "different accepted content");
    await db.remoteFiles.update("replacement", { heads: [accepted.id] });
    await cleanupLocalData(db, files, context());
    expect(await db.reconciliations.count()).toBe(1); expect(stages.has(object)).toBe(true);
  });

  it("persists accepted import evidence before compacting ancestry while a conflict remains", async () => {
    const { archive, object, imported, resolved } = await collision();
    await db.progress.update("progress", { checkpoint: 0 });
    await db.baseProofs.put({ id: imported.id, proof: { vaultId: "vault", epoch: "epoch", fileId: imported.fileId, revisionId: imported.id, boundary: 4, digest: "1".repeat(64), token: "2".repeat(64) } });
    await db.conflicts.put({ id: "replacement", path: "note.md", heads: [resolved.id], reason: "waiting for review" });
    await cleanupLocalData(db, files, context());
    expect((await db.reconciliations.get(archive.id))?.acceptedRevision).toBe(imported.id);
    expect(await db.revisions.get(imported.id)).toBeDefined(); expect(stages.has(object)).toBe(true);
    const final = await revision("replacement", "explicit later choice", [resolved.id]);
    await db.remoteFiles.update("replacement", { heads: [final.id] }); await db.conflicts.clear();
    await cleanupLocalData(db, files, context());
    expect(await db.reconciliations.count()).toBe(0); expect(await db.rejectedOutbox.count()).toBe(0);
    expect(await db.revisions.toCollection().primaryKeys()).toEqual([final.id]); expect(stages.has(object)).toBe(false);
  });

  it.each(["unaccepted", "conflict", "pending", "journal", "draft", "archived-journal", "different-bytes"])("preserves initialization evidence with %s", async kind => {
    const { archive, object, imported } = await collision();
    if (kind === "unaccepted") await db.remoteFiles.update("replacement", { heads: [] });
    if (kind === "conflict") await db.conflicts.put({ id: "replacement", path: "note.md", heads: [imported.id], reason: "LOCAL_CHANGED" });
    if (kind === "pending") await db.outbox.add(outbox("replacement", stage()));
    if (kind === "journal") await db.applyTasks.put(task("replacement", stage()));
    if (kind === "draft") await db.mergeDrafts.put({ id: "replacement", ciphertext: new Uint8Array([1]) });
    if (kind === "archived-journal") await db.reconciliations.update(archive.id, { tasks: [task("replacement", stage())] });
    if (kind === "different-bytes") {
      const other = await revision("replacement", "different bytes"); await db.remoteFiles.update("replacement", { heads: [other.id] });
    }
    await cleanupLocalData(db, files, context());
    expect(await db.reconciliations.count()).toBe(1); expect(await db.rejectedOutbox.count()).toBe(1); expect(stages.has(object)).toBe(true);
  });

  it("preserves arbitrary dependency subsets under repeated cleanup", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 25 }), async protectedFlags => {
      await db.outbox.clear(); stages.clear(); removed.length = 0;
      const ids = protectedFlags.map(() => stage());
      for (const [index, keep] of protectedFlags.entries()) if (keep) await db.outbox.add(outbox(`file-${index}`, ids[index]!));
      await cleanupLocalData(db, files, context()); await cleanupLocalData(db, files, context());
      expect(stages).toEqual(new Set(ids.filter((_, index) => protectedFlags[index])));
    }), { numRuns: 30 });
  });
});
