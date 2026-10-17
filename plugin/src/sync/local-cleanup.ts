import { actionEntries } from "../../../protocol/src/actions.js";
import { canonical } from "../../../protocol/src/model.js";
import type { Action, Revision } from "../../../protocol/src/types.js";
import { pruneLocalMetadata } from "./metadata-cleanup.js";
import type { ApplyTask, Outbox, SyncDB } from "./store.js";

export interface StageCleanupPort {
  /** Only direct, valid stage IDs in this device's private staging directory. */
  stageList(): Promise<string[]>;
  stageRemove(id: string): Promise<void>;
}

interface CleanupContext {
  assertLease(): Promise<void>;
  manifestFingerprint(revision: Revision): string;
  fault?: (point: string) => void;
}

/** Run inside the engine's serialized, renewable lease. Stage IDs are never reused for new intents. */
export async function cleanupLocalData(db: SyncDB, files: StageCleanupPort, context: CleanupContext): Promise<void> {
  await context.assertLease();
  // Enumerate BEFORE reading roots: a later writer's new random stage ID must never become a candidate.
  const candidates = await files.stageList();
  const protectedStages = await db.transaction("rw", [db.leases, db.progress, db.inbox, db.outbox,
    db.applyTasks, db.conflicts, db.rejectedOutbox, db.reconciliations, db.revisions,
    db.remoteFiles, db.localFiles, db.mergeDrafts, db.baseProofs, db.metadataMigration], async () => {
    await context.assertLease();
    const progress = await db.progress.get("progress");
    if (progress) {
      let previousCompleted: number | undefined;
      for (const row of await db.inbox.orderBy("seq").toArray()) {
        if (!row.done) {
          previousCompleted = undefined;
          continue;
        }
        if (row.seq <= progress.applied) {
          await db.inbox.delete(row.seq);
          continue;
        }
        // One endpoint preserves each completed run across an unfinished group, without its payloads.
        if (previousCompleted !== undefined) await db.inbox.delete(previousCompleted);
        await db.inbox.put({ seq: row.seq, fileIds: [], done: true });
        previousCompleted = row.seq;
      }
    }

    const revisions = new Map((await db.revisions.toArray()).map(row => [row.id, row]));
    const remoteFiles = await db.remoteFiles.toArray();
    const outgoing = await db.outbox.toArray();
    const tasks = await db.applyTasks.toArray();
    const conflicts = await db.conflicts.toArray();
    const drafts = await db.mergeDrafts.toArray();
    for (const archive of await db.reconciliations.toArray()) {
      // Only the well-defined, rejected initialization flow can establish completion here.
      // Unclassified archives and archived journals remain recovery evidence.
      if (archive.reason !== "INITIAL_PATH_COLLISION" || archive.tasks.length ||
          !archive.outbox.length || await db.localFiles.get(archive.id)) continue;
      if (archive.outbox.some(row => row.request.actions.some(action =>
        action.fileId !== archive.id || (action.type !== "create" && action.type !== "edit")))) continue;
      const replacement = archive.replacementFileId
        ? remoteFiles.find(row => row.id === archive.replacementFileId)
        : remoteFiles.find(row => row.id !== archive.id && row.location.pathKey === archive.local.location.pathKey);
      if (!replacement) continue;
      if (progress?.checkpoint !== undefined && !archive.acceptedRevision) {
        for (const revision of revisions.values()) {
          if (revision.fileId !== replacement.id || revision.payload.kind !== "file" || context.manifestFingerprint(revision) !== archive.local.fingerprint) continue;
          const proof = await db.baseProofs.get(revision.id);
          if (proof?.proof.fileId !== replacement.id || proof.proof.revisionId !== revision.id) continue;
          archive.acceptedRevision = revision.id; await db.reconciliations.put(archive); break;
        }
      }
      if (replacement.heads.length !== 1) continue;
      const ids = new Set([archive.id, replacement.id]);
      if (outgoing.some(row => row.request.actions.some(action => ids.has(action.fileId))) ||
          tasks.some(row => ids.has(row.id)) || conflicts.some(row => ids.has(row.id)) ||
          drafts.some(row => ids.has(row.id))) continue;
      const original = revisions.get(archive.local.revision);
      if (!original || original.fileId !== archive.id || original.payload.kind !== "file" ||
          context.manifestFingerprint(original) !== archive.local.fingerprint) continue;
      // Local revisions also contain unsubmitted work. Only ancestry reachable from accepted remote heads
      // proves the original bytes were durably imported, even if subsequently resolved or renamed.
      const todo = [...replacement.heads], seen = new Set<string>();
      let imported = progress?.checkpoint !== undefined && !!archive.acceptedRevision;
      while (todo.length && progress?.checkpoint === undefined) {
        const id = todo.pop()!; if (seen.has(id)) continue; seen.add(id);
        const revision = revisions.get(id);
        if (!revision || revision.fileId !== replacement.id) continue;
        if (revision.payload.kind === "file" &&
            context.manifestFingerprint(revision) === archive.local.fingerprint) imported = true;
        todo.push(...revision.parents);
      }
      if (!imported) continue;
      await db.reconciliations.delete(archive.id);
      for (const intent of archive.outbox) {
        const rejected = await db.rejectedOutbox.get(intent.opId);
        if (rejected?.error === "INITIAL_PATH_COLLISION" &&
            canonical(rejected.request) === canonical(intent.request) &&
            canonical(rejected.objects) === canonical(intent.objects)) await db.rejectedOutbox.delete(intent.opId);
      }
    }

    const roots = new Set<string>();
    function retainActionObjects(action: Action): void {
      for (const entry of actionEntries([action])) {
        if ("payload" in entry) for (const id of entry.payload.objects) roots.add(id);
      }
    }
    function retainOutboxObjects(row: Outbox): void {
      for (const object of row.objects) roots.add(object.stage);
      for (const action of row.request.actions) retainActionObjects(action);
    }
    function retainApplyStages(task: ApplyTask): void {
      roots.add(task.stage);
      if (task.backup) roots.add(task.backup);
    }
    for (const row of outgoing) retainOutboxObjects(row); // Includes paused/excluded/failed uploads.
    for (const row of await db.rejectedOutbox.toArray()) retainOutboxObjects(row);
    for (const row of tasks) retainApplyStages(row);
    for (const row of await db.reconciliations.toArray()) {
      for (const intent of row.outbox) retainOutboxObjects(intent);
      for (const task of row.tasks) retainApplyStages(task);
      for (const id of revisions.get(row.local.revision)?.payload.objects ?? []) roots.add(id);
    }
    for (const conflict of conflicts) for (const head of conflict.heads) {
      for (const id of revisions.get(head)?.payload.objects ?? []) roots.add(id);
    }
    for (const row of await db.inbox.toArray()) if (!row.done && row.change) {
      for (const action of row.change.actions) retainActionObjects(action);
    }
    for (const migration of await db.metadataMigration.toArray()) {
      for (const request of migration.requests) for (const action of request.actions) retainActionObjects(action);
    }
    if (progress?.checkpoint !== undefined) {
      await pruneLocalMetadata(db);
      context.fault?.("before-local-metadata-cleanup-commit");
    }
    await context.assertLease();
    context.fault?.("before-local-cleanup-commit");
    return roots;
  });
  context.fault?.("after-local-cleanup-commit");
  if ((await db.progress.get("progress"))?.checkpoint !== undefined) context.fault?.("after-local-metadata-cleanup-commit");
  for (const id of candidates) {
    if (!/^(?:c_)?[a-f0-9]{64}$/.test(id) || protectedStages.has(id)) continue;
    await context.assertLease();
    context.fault?.("before-stage-remove");
    await files.stageRemove(id);
    context.fault?.("after-stage-remove");
  }
  await context.assertLease();
}
