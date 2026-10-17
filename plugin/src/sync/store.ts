import Dexie, { type Table } from "dexie";
import type { Change, Commit, FileState, Revision } from "../../../protocol/src/types";
import type { BaseProof, RequestCoordinate, RequestAck } from "../../../protocol/src/metadata";

export interface LocalFile {
  id: string; path: string; location: FileState["location"]; revision: string; fingerprint: string; deleted: boolean;
}
export interface Outbox {
  queueId?: number; opId: string; request: Commit; objects: { id: string; stage: string }[]; error?: string; coordinate?: RequestCoordinate;
}
export interface Inbox { seq: number; fileIds: string[]; done: boolean; change?: Change }
export interface Progress { id: "progress"; vaultId: string; epoch: string; received: number; applied: number; checkpoint?: number }
export interface Conflict { id: string; path: string; heads: string[]; reason: string }
export interface ApplyTask {
  id: string; sourcePath: string; targetPath: string; oldFingerprint: string | null; desiredFingerprint: string;
  revision: string; location: FileState["location"]; deleted: boolean; stage: string; backup?: string; size?: number;
}
export interface SkippedFile { id: string; path: string; reason: string }
export interface Reconciliation {
  id: string; reason: string; local: LocalFile; outbox: Outbox[]; tasks: ApplyTask[];
  replacementFileId?: string;
  acceptedRevision?: string;
}
export class SyncDB extends Dexie {
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
  }
}
