/** Experimental semantic model v0; these are not a frozen network/crypto format. */
export interface Payload {
  kind: "file" | "directory" | "deleted";
  keyEpoch: number;
  encryptedManifest: string;
  objects: string[];
}
export interface Revision {
  id: string;
  fileId: string;
  parents: string[];
  deviceId: string;
  payload: Payload;
  selectedFrom?: string;
}
export interface Location {
  revision: string;
  pathKey: string;
  encryptedPath: string;
}
export interface FileState {
  id: string;
  entryKind: "file" | "directory";
  location: Location;
  heads: string[];
}
export interface Create {
  type: "create";
  fileId: string;
  revisionId: string;
  payload: Payload;
  location: Location;
}
export interface Edit {
  type: "edit";
  fileId: string;
  revisionId: string;
  /** Exactly the revision displayed while these bytes were edited. */
  displayedRevision: string;
  payload: Payload;
}
export interface Move {
  type: "move";
  fileId: string;
  expectedLocation: string;
  location: Location;
}
export interface Resolve {
  type: "resolve";
  fileId: string;
  observedHeads: string[];
  expectedLocation?: string;
  revisionId: string;
  payload: Payload;
  decision:
    | { kind: "select"; selectedRevision: string }
    | { kind: "manual" }
    | { kind: "keep-both"; selectedRevision: string; companionSource: string; companion: Create };
}
export interface IndependentBranch { type: "branch"; fileId: string; revisionId: string; payload: Payload }
export type Action = Create | Edit | Move | Resolve | IndependentBranch;
export interface Commit {
  protocol: 0;
  vaultId: string;
  epoch: string;
  requiredFeatures: string[];
  deviceId: string;
  opId: string;
  actions: Action[];
}
export interface Change {
  seq: number;
  deviceId: string;
  opId: string;
  /** An entire atomic group; pagination must not split it. */
  actions: Action[];
}
export interface Receipt { epoch: string; seq: number; opId: string }
export interface Snapshot {
  checkpoint?: number;
  bases?: import("./metadata").BaseProof[];
  epoch: string;
  boundary: number;
  files: FileState[];
  revisions: Revision[];
}
export type ErrorCode = "UNSUPPORTED_PROTOCOL" | "WRONG_VAULT" | "EPOCH_CHANGED"
  | "INVALID_REQUEST" | "OP_ID_REUSED" | "FILE_EXISTS" | "FILE_MISSING"
  | "REVISION_EXISTS" | "PARENT_MISSING" | "OBJECT_MISSING" | "LOCATION_STALE"
  | "PATH_OCCUPIED" | "REVIEW_STALE" | "NEED_SNAPSHOT";
export class ProtocolError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); }
}
