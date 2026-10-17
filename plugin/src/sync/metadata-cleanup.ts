import { actionEntries } from "../../../protocol/src/actions.js";
import type { Action, Commit } from "../../../protocol/src/types.js";
import type { ApplyTask, Outbox, SyncDB } from "./store.js";

/** Caller owns the engine lease and one transaction over all dependency tables. Parent strings are
 * authenticated context, not retention roots, once complete-head projection has been negotiated. */
export async function pruneLocalMetadata(db: SyncDB): Promise<void> {
  const roots = new Set<string>();
  function retainActionRevisions(value: Action): void {
    if ("revisionId" in value) roots.add(value.revisionId);
    if (value.type === "edit") roots.add(value.displayedRevision);
    if (value.type === "resolve") {
      for (const id of value.observedHeads) roots.add(id);
      if (value.decision.kind !== "manual") roots.add(value.decision.selectedRevision);
      if (value.decision.kind === "keep-both") roots.add(value.decision.companionSource);
    }
  }
  function retainRequestRevisions(value: Commit): void {
    for (const item of actionEntries(value.actions)) retainActionRevisions(item);
  }
  function retainOutboxRevisions(value: Outbox): void { retainRequestRevisions(value.request); }
  function retainApplyRevision(value: ApplyTask): void { roots.add(value.revision); }
  for (const row of await db.localFiles.toArray()) roots.add(row.revision);
  for (const row of await db.remoteFiles.toArray()) for (const id of row.heads) roots.add(id);
  for (const row of await db.conflicts.toArray()) for (const id of row.heads) roots.add(id);
  for (const row of await db.outbox.toArray()) retainOutboxRevisions(row);
  for (const row of await db.rejectedOutbox.toArray()) {
    retainOutboxRevisions(row);
    if (row.supersededBy) roots.add(row.supersededBy);
  }
  for (const row of await db.applyTasks.toArray()) retainApplyRevision(row);
  for (const row of await db.inbox.toArray()) {
    if (!row.done && row.change) for (const item of actionEntries(row.change.actions)) retainActionRevisions(item);
  }
  for (const row of await db.reconciliations.toArray()) {
    roots.add(row.local.revision);
    if (row.acceptedRevision) roots.add(row.acceptedRevision);
    for (const item of row.outbox) retainOutboxRevisions(item);
    for (const item of row.tasks) retainApplyRevision(item);
  }
  for (const migration of await db.metadataMigration.toArray()) {
    for (const value of migration.requests) retainRequestRevisions(value);
  }
  await db.revisions.bulkDelete((await db.revisions.toCollection().primaryKeys()).filter(id => !roots.has(id)));
  await db.baseProofs.bulkDelete((await db.baseProofs.toCollection().primaryKeys()).filter(id => !roots.has(id)));
}
