import { baseAnchorSchema, type BaseAnchor } from "../../../protocol/src/metadata.js";
import type { FileState, Revision, Snapshot } from "../../../protocol/src/types.js";
import { databaseBatches, type Progress, type SyncDB } from "./store.js";
import type { Transport } from "./transport.js";

type SnapshotHeader = Pick<Snapshot, "epoch" | "boundary" | "checkpoint">;
interface SnapshotContext {
  vaultId: string;
  epoch?: string;
  compact: boolean;
  assertLease(): Promise<void>;
  authenticateFile(file: FileState): void;
  authenticateRevision(revision: Revision): void;
  verifyAnchor(anchor: BaseAnchor): Promise<void>;
  fault?(point: string): void;
}

async function validateSnapshot(db: SyncDB, header: SnapshotHeader, context: SnapshotContext): Promise<Progress | undefined> {
  if (context.epoch !== undefined && header.epoch !== context.epoch) {
    throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
  }
  const previous = await db.progress.get("progress");
  if ((context.compact || previous?.checkpoint !== undefined) && header.checkpoint === undefined) {
    throw new Error("INVALID_SNAPSHOT");
  }
  if (header.checkpoint !== undefined && header.checkpoint > header.boundary) {
    throw new Error("INVALID_SNAPSHOT");
  }
  if (previous && (header.epoch !== previous.epoch || header.boundary < previous.received ||
      previous.checkpoint !== undefined && header.checkpoint! < previous.checkpoint)) {
    throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
  }
  for await (const files of databaseBatches(db.remoteFiles)) {
    for (const file of files) {
      if (!await db.snapshotFiles.get(file.id)) throw new Error("INCOMPLETE_SNAPSHOT");
    }
  }
  for await (const heads of databaseBatches(db.snapshotHeads)) {
    for (const head of heads) {
      const revision = await db.snapshotRevisions.get(head.id);
      if (revision?.fileId !== head.fileId) throw new Error("INVALID_SNAPSHOT");
    }
  }
  if (header.checkpoint !== undefined) {
    const headCount = await db.snapshotHeads.count();
    if (headCount !== await db.snapshotRevisions.count() || headCount !== await db.snapshotProofs.count()) {
      throw new Error("INVALID_SNAPSHOT");
    }
    for await (const revisions of databaseBatches(db.snapshotRevisions)) {
      for (const revision of revisions) {
        const proof = (await db.snapshotProofs.get(revision.id))?.proof;
        if (!proof || proof.epoch !== header.epoch || proof.boundary !== header.boundary) {
          throw new Error("BASE_ANCHOR_MISMATCH");
        }
        await context.verifyAnchor(baseAnchorSchema.parse({ revision, proof }));
      }
    }
  }
  return previous;
}

/** Keep payloads in private IndexedDB, never a whole-vault JavaScript snapshot object. */
export async function receiveSnapshot(db: SyncDB, remote: Transport, context: SnapshotContext): Promise<void> {
  const staged = [db.snapshotFiles, db.snapshotRevisions, db.snapshotProofs, db.snapshotHeads];
  await db.transaction("rw", [db.leases, ...staged], async () => {
    await context.assertLease();
    for (const table of staged) await table.clear();
  });
  const header: SnapshotHeader = await remote.snapshotPages(async page => {
    for (const file of page.files) context.authenticateFile(file);
    for (const revision of page.revisions) context.authenticateRevision(revision);
    await db.transaction("rw", [db.leases, ...staged], async () => {
      await context.assertLease();
      await db.snapshotFiles.bulkAdd(page.files);
      await db.snapshotRevisions.bulkAdd(page.revisions);
      await db.snapshotHeads.bulkAdd(page.files.flatMap(file => file.heads.map(id => ({ id, fileId: file.id }))));
      await db.snapshotProofs.bulkAdd((page.bases ?? []).map(proof => ({ id: proof.revisionId, proof })));
      context.fault?.("before-snapshot-page-commit");
    });
    context.fault?.("after-snapshot-page-commit");
  });
  const previous = await validateSnapshot(db, header, context);
  await db.transaction("rw", [db.leases, ...staged, db.remoteFiles, db.revisions, db.inbox, db.progress, db.baseProofs, db.writerState], async () => {
    await context.assertLease();
    await db.remoteFiles.clear();
    await db.inbox.clear();
    for await (const files of databaseBatches(db.snapshotFiles)) await db.remoteFiles.bulkPut(files);
    for await (const revisions of databaseBatches(db.snapshotRevisions)) await db.revisions.bulkPut(revisions);
    if (header.checkpoint !== undefined) {
      for await (const proofs of databaseBatches(db.snapshotProofs)) await db.baseProofs.bulkPut(proofs);
    }
    const writer = await db.writerState.get("writer");
    if (writer) {
      writer.highestServerSeq = Math.max(writer.highestServerSeq, header.boundary);
      await db.writerState.put(writer);
    }
    const fileIds = await db.snapshotFiles.toCollection().primaryKeys();
    await db.inbox.put({ seq: header.boundary, fileIds, done: false });
    await db.progress.put({
      id: "progress", vaultId: context.vaultId, epoch: header.epoch,
      received: header.boundary, applied: previous?.applied ?? 0,
      ...(header.checkpoint === undefined ? {} : { checkpoint: header.checkpoint }),
    });
    for (const table of staged) await table.clear();
    context.fault?.("before-snapshot-commit");
  });
  context.fault?.("after-snapshot-commit");
}
