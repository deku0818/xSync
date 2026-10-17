import type { Action, Commit } from "../../../protocol/src/types";
import type { ApplyTask, Outbox, SyncDB } from "./store";

/** Caller owns the engine lease and one transaction over all dependency tables. Parent strings are
 * authenticated context, not retention roots, once complete-head projection has been negotiated. */
export async function pruneLocalMetadata(db: SyncDB): Promise<void> {
  const roots = new Set<string>();
  const action = (value: Action) => {
    if ("revisionId" in value) roots.add(value.revisionId);
    if (value.type === "edit") roots.add(value.displayedRevision);
    if (value.type === "resolve") {
      for (const id of value.observedHeads) roots.add(id);
      if (value.decision.kind !== "manual") roots.add(value.decision.selectedRevision);
      if (value.decision.kind === "keep-both") { roots.add(value.decision.companionSource); action(value.decision.companion); }
    }
  };
  const request = (value: Commit) => { for (const item of value.actions) action(item); };
  const outbox = (value: Outbox) => request(value.request);
  const task = (value: ApplyTask) => roots.add(value.revision);
  for (const row of await db.localFiles.toArray()) roots.add(row.revision);
  for (const row of await db.remoteFiles.toArray()) for (const id of row.heads) roots.add(id);
  for (const row of await db.conflicts.toArray()) for (const id of row.heads) roots.add(id);
  for (const row of await db.outbox.toArray()) outbox(row);
  for (const row of await db.rejectedOutbox.toArray()) outbox(row);
  for (const row of await db.applyTasks.toArray()) task(row);
  for (const row of await db.inbox.toArray()) if (!row.done && row.change) for (const item of row.change.actions) action(item);
  for (const row of await db.reconciliations.toArray()) {
    roots.add(row.local.revision);
    if (row.acceptedRevision) roots.add(row.acceptedRevision);
    for (const item of row.outbox) outbox(item);
    for (const item of row.tasks) task(item);
  }
  for (const migration of await db.metadataMigration.toArray()) for (const value of migration.requests) request(value);
  await db.revisions.bulkDelete((await db.revisions.toCollection().primaryKeys()).filter(id => !roots.has(id)));
  await db.baseProofs.bulkDelete((await db.baseProofs.toCollection().primaryKeys()).filter(id => !roots.has(id)));
}
