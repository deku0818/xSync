import Dexie, { type Table, type Transaction } from "dexie";

import type { BaseProof, RequestAck, RequestCoordinate } from "../../../protocol/src/metadata.js";
import type { Change, Commit, FileState, Revision } from "../../../protocol/src/types.js";

export interface LocalFile {
  id: string; path: string; location: FileState["location"]; revision: string; fingerprint: string; deleted: boolean;
}
export interface Outbox {
  queueId?: number; opId: string; request: Commit; objects: { id: string; stage: string }[]; error?: string; coordinate?: RequestCoordinate;
  /** Retire only after this explicit replacement is accepted and the file has a settled current view. */
  supersededBy?: string;
}
export interface Inbox { seq: number; fileIds: string[]; done: boolean; change?: Change }
export interface Progress { id: "progress"; vaultId: string; epoch: string; received: number; applied: number; checkpoint?: number }
export interface Conflict { id: string; path: string; heads: string[]; reason: string }
export interface ApplyTask {
  id: string; sourcePath: string; targetPath: string; oldFingerprint: string | null; desiredFingerprint: string;
  revision: string; location: FileState["location"]; deleted: boolean; stage: string; backup?: string; size?: number;
  /** Only explicit false proves this journal has never entered a filesystem mutation. Older rows are unknown. */
  mutationStarted?: boolean;
  chunks?: string[];
  backupChunks?: string[];
}
export interface SkippedFile { id: string; path: string; reason: string }
export interface Reconciliation {
  id: string; reason: string; local: LocalFile; outbox: Outbox[]; tasks: ApplyTask[];
  replacementFileId?: string;
  acceptedRevision?: string;
}
export class SyncDB extends Dexie {
  snapshotFiles!: Table<FileState, string>;
  snapshotRevisions!: Table<Revision, string>;
  snapshotProofs!: Table<{ id: string; proof: BaseProof }, string>;
  snapshotHeads!: Table<{ id: string; fileId: string }, string>;
  dirtyFiles!: Table<{ path: string; generation: number }, string>;
  writeVersion = 0;
  async markDirty(path: string): Promise<void> {
    await this.transaction("rw", this.dirtyFiles, async () => {
      const prior = await this.dirtyFiles.get(path);
      await this.dirtyFiles.put({ path, generation: (prior?.generation ?? 0) + 1 });
    });
  }
  continuity!: Table<{ id: "continuity"; token: string; pending?: string; bootstrap: boolean }, string>;
  metadataMigration!: Table<{ id: "migration" | "objects"; complete: boolean; requests: Commit[] }, string>;
  writerState!: Table<{ id: "writer"; stream: string; next: number; highestServerSeq: number }, string>;
  baseProofs!: Table<{ id: string; proof: BaseProof }, string>;
  requestAcks!: Table<{ id: string; ack: RequestAck }, string>;
  skipped!: Table<SkippedFile, string>;
  reconciliations!: Table<Reconciliation, string>;
  mergeDrafts!: Table<{ id: string; ciphertext: Uint8Array }, string>;
  progress!: Table<Progress, string>;
  localFiles!: Table<LocalFile, string>;
  remoteFiles!: Table<FileState, string>;
  revisions!: Table<Revision, string>;
  outbox!: Table<Outbox, number>;
  rejectedOutbox!: Table<Outbox, string>;
  inbox!: Table<Inbox, number>;
  conflicts!: Table<Conflict, string>;
  applyTasks!: Table<ApplyTask, string>;
  leases!: Table<{ id: string; owner: string; until: number }, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ progress: "id", localFiles: "id,&path", remoteFiles: "id", revisions: "id",
      outbox: "++queueId,&opId", inbox: "seq", conflicts: "id", applyTasks: "id", leases: "id" });
    this.version(2).stores({ rejectedOutbox: "opId" });
    this.version(3).stores({ skipped: "id", mergeDrafts: "id" });
    this.version(4).stores({ reconciliations: "id" });
    this.version(5).stores({ writerState: "id", baseProofs: "id", requestAcks: "id" });
    this.version(6).stores({ metadataMigration: "id" });
    this.version(7).stores({ metadataMigration: "id" });
    this.version(8).stores({ continuity: "id" });
    // Incoming atomic groups may exchange paths; an IndexedDB unique index is not deferrable.
    this.version(9).stores({ dirtyFiles: "path", remoteFiles: "id,location.pathKey" });
    this.version(10).stores({ snapshotFiles: "id", snapshotRevisions: "id", snapshotProofs: "id", snapshotHeads: "id" });
    const watched = new WeakSet<Transaction>();
    const changed = (transaction: Transaction): void => {
      if (watched.has(transaction)) return;
      watched.add(transaction);
      transaction.on("complete", () => { this.writeVersion++; });
    };
    const counted = new Set(["outbox", "inbox", "conflicts", "applyTasks", "skipped", "dirtyFiles"]);
    for (const table of this.tables.filter(table => counted.has(table.name))) {
      table.hook("creating", (_key, _row, transaction) => { changed(transaction); });
      table.hook("updating", (_changes, _key, _row, transaction) => { changed(transaction); });
      table.hook("deleting", (_key, _row, transaction) => { changed(transaction); });
    }
  }
}

/** Bounded payload batches for full verification and snapshot activation. */
export async function* databaseBatches<T extends { id: string }>(table: Table<T, string>, size = 16): AsyncGenerator<T[]> {
  let after = "";
  for (;;) {
    const rows = await table.where("id").above(after).limit(size).toArray();
    if (!rows.length) return;
    yield rows;
    after = rows.at(-1)!.id;
  }
}
