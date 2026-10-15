import { ProtocolError, type Action, type Change, type Commit, type Create,
  type FileState, type Payload, type Receipt, type Revision, type Snapshot } from "./types";

const copy = <T>(value: T): T => structuredClone(value);
function fail(code: ConstructorParameters<typeof ProtocolError>[0]): never { throw new ProtocolError(code); }
const unique = (xs: string[]) => new Set(xs).size === xs.length;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));
const id = (s: string) => { if (typeof s !== "string" || !s.length || s.length > 256) fail("INVALID_REQUEST"); };

/** Compare the actual canonical body, never a caller-supplied digest. No timestamps. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return fail("INVALID_REQUEST");
}

/** Executable reference model ONLY. Objects here are assertions, not disk durability. */
export class VaultModel {
  private files = new Map<string, FileState>();
  private revisions = new Map<string, Revision>();
  private objects = new Set<string>();
  private locationIds = new Set<string>();
  private operations = new Map<string, { body: string; receipt: Receipt }>();
  private changes: Change[] = [];
  private sequence = 0;
  private retainedAfter = 0;
  readonly features = ["causal-heads", "atomic-groups", "review-cas", "shared-config-v1", "chunked-files-v1", "client-profiles-v1", "independent-branches-v1"];
  constructor(readonly vaultId: string, readonly epoch: string) {}

  /** Test fixture for the future durable-object adapter. Never a production upload API. */
  declareDurableObject(blobId: string): void { id(blobId); this.objects.add(blobId); }

  commit(input: Commit): Receipt {
    const request = copy(input);
    if (request.protocol !== 0 || request.requiredFeatures.some(x => !this.features.includes(x))) fail("UNSUPPORTED_PROTOCOL");
    if (request.vaultId !== this.vaultId) fail("WRONG_VAULT");
    if (request.epoch !== this.epoch) fail("EPOCH_CHANGED");
    id(request.deviceId); id(request.opId);
    const body = canonical(request);
    const key = canonical([request.deviceId, request.opId]);
    const prior = this.operations.get(key);
    if (prior) {
      if (body !== prior.body) fail("OP_ID_REUSED");
      return copy(prior.receipt);
    }
    if (!request.actions.length || request.actions.length > 1000) fail("INVALID_REQUEST");
    // Copy-on-write represents the SQL transaction; failures publish absolutely nothing.
    const files = copy(this.files);
    const revisions = copy(this.revisions);
    const locationIds = copy(this.locationIds);
    const touched = new Set<string>();
    const moved = new Set<string>();
    const newLocation = (l: FileState["location"]) => {
      this.validateLocation(l);
      if (locationIds.has(l.revision)) fail("LOCATION_STALE");
      locationIds.add(l.revision);
    };
    const addRevision = (file: FileState, revisionId: string, parents: string[], payload: Payload, selectedFrom?: string) => {
      id(revisionId);
      if (revisions.has(revisionId)) fail("REVISION_EXISTS");
      this.validatePayload(payload, file.entryKind);
      const r: Revision = { id: revisionId, fileId: file.id, parents: [...parents], deviceId: request.deviceId, payload: copy(payload) };
      if (selectedFrom !== undefined) r.selectedFrom = selectedFrom;
      revisions.set(revisionId, r);
      // Only ancestors of the new revision stop being heads. Unobserved siblings survive.
      const ancestors = new Set<string>();
      const todo = [...parents];
      while (todo.length) {
        const next = todo.pop()!;
        if (ancestors.has(next)) continue;
        const ancestor = revisions.get(next);
        if (!ancestor || ancestor.fileId !== file.id) fail("PARENT_MISSING");
        ancestors.add(next); todo.push(...ancestor.parents);
      }
      file.heads = [...file.heads.filter(h => !ancestors.has(h)), revisionId].sort();
    };
    const create = (a: Create) => {
      id(a.fileId); newLocation(a.location);
      if (files.has(a.fileId)) fail("FILE_EXISTS");
      if (a.payload.kind === "deleted") fail("INVALID_REQUEST");
      const f: FileState = { id: a.fileId, entryKind: a.payload.kind, location: copy(a.location), heads: [] };
      addRevision(f, a.revisionId, [], a.payload);
      files.set(f.id, f);
    };
    for (const a of request.actions) {
      id(a.fileId);
      // One content/lifecycle intent and one location intent per file per group.
      const set = a.type === "move" ? moved : touched;
      if (set.has(a.fileId)) fail("INVALID_REQUEST");
      set.add(a.fileId);
      if (a.type === "create") { create(a); continue; }
      const f = files.get(a.fileId);
      if (!f) fail("FILE_MISSING");
      switch (a.type) {
        case "branch": {
          if (a.payload.kind !== "file") fail("INVALID_REQUEST");
          addRevision(f, a.revisionId, [], a.payload); break;
        }
        case "edit": {
          const parent = revisions.get(a.displayedRevision);
          if (!parent || parent.fileId !== f.id) fail("PARENT_MISSING");
          // Editing an old displayed parent is legal, and creates a preserved branch.
          addRevision(f, a.revisionId, [a.displayedRevision], a.payload);
          break;
        }
        case "move": {
          if (f.location.revision !== a.expectedLocation) fail("LOCATION_STALE");
          newLocation(a.location);
          f.location = copy(a.location);
          break;
        }
        case "resolve": {
          if (a.expectedLocation !== undefined && a.expectedLocation !== f.location.revision) fail("REVIEW_STALE");
          if (!unique(a.observedHeads) || f.heads.length < 2 || !sameSet(f.heads, a.observedHeads)) fail("REVIEW_STALE");
          const decision = a.decision;
          if (decision.kind !== "manual") {
            if (!a.observedHeads.includes(decision.selectedRevision)) fail("INVALID_REQUEST");
            const selected = revisions.get(decision.selectedRevision)!;
            // The server cannot verify plaintext equality. Client must authenticate/re-encrypt the chosen snapshot.
            if (selected.payload.kind !== a.payload.kind || selected.payload.keyEpoch !== a.payload.keyEpoch ||
                canonical(selected.payload.objects) !== canonical(a.payload.objects)) fail("INVALID_REQUEST");
            if (decision.kind === "keep-both") {
              if (a.observedHeads.length !== 2 || decision.companionSource === decision.selectedRevision ||
                  !a.observedHeads.includes(decision.companionSource)) fail("INVALID_REQUEST");
              const source = revisions.get(decision.companionSource)!;
              if (source.payload.kind === "deleted" || source.payload.kind !== decision.companion.payload.kind ||
                  source.payload.keyEpoch !== decision.companion.payload.keyEpoch ||
                  canonical(source.payload.objects) !== canonical(decision.companion.payload.objects)) fail("INVALID_REQUEST");
              if (touched.has(decision.companion.fileId)) fail("INVALID_REQUEST");
              touched.add(decision.companion.fileId);
              create(decision.companion);
              revisions.get(decision.companion.revisionId)!.selectedFrom = source.id;
            } else if (decision.kind !== "select") fail("INVALID_REQUEST");
          }
          addRevision(f, a.revisionId, a.observedHeads, a.payload,
            decision.kind === "manual" ? undefined : decision.selectedRevision);
          break;
        }
        default: fail("INVALID_REQUEST");
      }
    }
    // Check the FINAL namespace, allowing an atomic swap. Tombstones reserve paths in v0.
    const occupied = new Set<string>();
    for (const f of files.values()) {
      if (occupied.has(f.location.pathKey)) fail("PATH_OCCUPIED");
      occupied.add(f.location.pathKey);
    }
    const receipt = { epoch: this.epoch, seq: this.sequence + 1, opId: request.opId };
    this.files = files; this.revisions = revisions; this.locationIds = locationIds; this.sequence = receipt.seq;
    this.operations.set(key, { body, receipt });
    this.changes.push({ seq: receipt.seq, deviceId: request.deviceId, opId: request.opId, actions: request.actions });
    return copy(receipt);
  }

  private validatePayload(p: Payload, entryKind: FileState["entryKind"]): void {
    if (![entryKind, "deleted"].includes(p.kind) || !Number.isSafeInteger(p.keyEpoch) || p.keyEpoch < 1 ||
        typeof p.encryptedManifest !== "string" || !p.encryptedManifest || !Array.isArray(p.objects)) fail("INVALID_REQUEST");
    if (p.kind !== "file" && p.objects.length) fail("INVALID_REQUEST");
    for (const object of p.objects) { id(object); if (!this.objects.has(object)) fail("OBJECT_MISSING"); }
  }
  private validateLocation(l: FileState["location"]): void { id(l.revision); id(l.pathKey); if (!l.encryptedPath) fail("INVALID_REQUEST"); }
  snapshot(): Snapshot {
    return copy({ epoch: this.epoch, boundary: this.sequence, files: [...this.files.values()], revisions: [...this.revisions.values()] });
  }
  pull(epoch: string, after: number, limit = 100): Change[] {
    if (epoch !== this.epoch) fail("EPOCH_CHANGED");
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence || !Number.isSafeInteger(limit) || limit < 1) fail("INVALID_REQUEST");
    if (after < this.retainedAfter) fail("NEED_SNAPSHOT");
    return copy(this.changes.filter(c => c.seq > after).slice(0, limit));
  }
  /** Model log expiration only; this is not GC or backup implementation. */
  expireLogThrough(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < this.retainedAfter || seq > this.sequence) fail("INVALID_REQUEST");
    this.retainedAfter = seq; this.changes = this.changes.filter(c => c.seq > seq);
  }
}

export function editFromDisplayed(fileId: string, revisionId: string, displayedRevision: string, payload: Payload): Action {
  return { type: "edit", fileId, revisionId, displayedRevision, payload: copy(payload) };
}
