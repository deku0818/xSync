import Dexie, { type Table } from "dexie";
import type { Change, Commit, FileState, Revision } from "../../../protocol/src/types";

export interface LocalFile {
  id: string; path: string; location: FileState["location"]; revision: string; fingerprint: string; deleted: boolean;
}
export interface Outbox {
  queueId?: number; opId: string; request: Commit; objects: { id: string; stage: string }[]; error?: string;
}
export interface Inbox { seq: number; fileIds: string[]; done: boolean; change?: Change }
export interface Progress { id: "progress"; vaultId: string; epoch: string; received: number; applied: number }
export interface Conflict { id: string; path: string; heads: string[]; reason: string }
export interface ApplyTask {
  id: string; sourcePath: string; targetPath: string; oldFingerprint: string | null; desiredFingerprint: string;
  revision: string; location: FileState["location"]; deleted: boolean; stage: string; backup?: string; size?: number;
}
export interface SkippedFile { id: string; path: string; reason: string }
export class SyncDB extends Dexie {
  skipped!: Table<SkippedFile, string>;
  reconciliations!: Table<{ id: string; reason: string; local: LocalFile; outbox: Outbox[]; tasks: ApplyTask[] }, string>;
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
  }
}
