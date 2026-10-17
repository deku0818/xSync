import { canonical } from "../../../protocol/src/model";
import { baseAnchorSchema, derivedOperation, type BaseAnchor, type BaseProof, type RequestCoordinate } from "../../../protocol/src/metadata";
import type { Snapshot } from "../../../protocol/src/types";
import { isAddressedObject } from "../../../protocol/src/objects";
import { fingerprint } from "./crypto";
import type { SyncDB, Outbox } from "./store";
import { Transport, RemoteError } from "./transport";
import { ContinuityClient } from "./continuity-client";

export async function revisionDigest(revision: unknown): Promise<string> {
  const escaped: Record<string, string> = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" };
  return fingerprint(new TextEncoder().encode(canonical(revision).replace(/[<>&\u2028\u2029]/g, char => escaped[char]!)));
}

export class MetadataClient {
  constructor(private db: SyncDB, private remote: Transport, private vaultId: string,
    private assertLease: () => Promise<void>, private authenticate: (anchor: BaseAnchor) => void,
    private fault: (point: string) => void) {}

  async initialize(serverSequence: number, metadataCheckpoint?: number, continuity = false): Promise<void> {
    const checkpoint = await this.db.writerState.get("writer");
    if (checkpoint && serverSequence < checkpoint.highestServerSeq) throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
    const stream = await this.remote.requestStream();
    await this.db.transaction("rw", [this.db.leases, this.db.writerState], async () => {
      await this.assertLease(); const local = await this.db.writerState.get("writer");
      if (local && (local.stream !== stream.id || local.next <= stream.maximum || serverSequence < local.highestServerSeq)) {
        throw new Error("REQUEST_STREAM_RECONCILIATION_REQUIRED");
      }
      if (!local) await this.db.writerState.put({ id: "writer", stream: stream.id, next: stream.maximum + 1, highestServerSeq: serverSequence });
    });
    if (continuity) {
      await new ContinuityClient(this.db, this.remote, this.assertLease, this.fault).initialize();
      await this.bootstrapBaselines();
    }
    if (metadataCheckpoint !== undefined) { await this.registerLegacy("migration"); await this.registerLegacy("objects"); }
    await this.acknowledgePending();
  }

  private async bootstrapBaselines(): Promise<void> {
    if (!(await this.db.continuity.get("continuity"))?.bootstrap) return;
    const pending = await this.db.outbox.toArray(), created = new Set<string>(), roots = new Set<string>();
    for (const row of pending) for (const action of row.request.actions) {
      if ("revisionId" in action) created.add(action.revisionId);
      if (action.type === "resolve" && action.decision.kind === "keep-both") created.add(action.decision.companion.revisionId);
    }
    for (const file of await this.db.localFiles.toArray()) roots.add(file.revision);
    for (const file of await this.db.remoteFiles.toArray()) for (const id of file.heads) roots.add(id);
    for (const task of await this.db.applyTasks.toArray()) roots.add(task.revision);
    for (const row of pending) for (const action of row.request.actions) {
      if (action.type === "edit") roots.add(action.displayedRevision);
      if (action.type === "resolve") for (const id of action.observedHeads) roots.add(id);
    }
    for (const id of roots) if (!created.has(id)) {
      try { await this.certify(id); }
      catch (error) {
        if ((error instanceof RemoteError && error.code === "BASE_NOT_ACCEPTED") || (error instanceof Error && error.message === "LOCAL_BASE_UNAVAILABLE")) throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
        throw error;
      }
    }
    await this.db.transaction("rw", [this.db.leases, this.db.continuity], async () => {
      await this.assertLease(); const local = await this.db.continuity.get("continuity");
      if (!local) throw new Error("CONTINUITY_STATE_MISSING");
      local.bootstrap = false; await this.db.continuity.put(local); this.fault("before-baseline-bootstrap-commit");
    });
    this.fault("after-baseline-bootstrap-commit");
  }

  private async registerLegacy(kind: "migration" | "objects"): Promise<void> {
    let migration = await this.db.metadataMigration.get(kind);
    if (migration?.complete) return;
    if (!migration) {
      migration = await this.db.transaction("rw", [this.db.leases, this.db.metadataMigration, this.db.outbox], async () => {
        await this.assertLease();
        const requests = (await this.db.outbox.orderBy("queueId").toArray()).filter(row => kind === "migration"
          ? !row.coordinate || row.request.opId !== derivedOperation(row.coordinate)
          : row.request.actions.some(action => ("payload" in action && action.payload.objects.some(id => !isAddressedObject(id))) || (action.type === "resolve" && action.decision.kind === "keep-both" && action.decision.companion.payload.objects.some(id => !isAddressedObject(id))))).map(row => row.request);
        const value = { id: kind, complete: false, requests };
        await this.db.metadataMigration.put(value); return value;
      });
    }
    if (migration.requests.length === 0) {
      const state = await this.remote.migrationState();
      if (kind === "migration" ? state.legacy : state.objects) {
        await this.db.transaction("rw", [this.db.leases, this.db.metadataMigration], async () => {
          await this.assertLease(); await this.db.metadataMigration.put({ id: kind, complete: true, requests: [] });
        });
        return;
      }
    }
    if (kind === "migration") await this.remote.registerLegacy(migration.requests);
    else await this.remote.registerLegacyObjects(migration.requests);
    this.fault(kind === "migration" ? "after-legacy-registration-response" : "after-object-registration-response");
    await this.db.transaction("rw", [this.db.leases, this.db.metadataMigration], async () => {
      await this.assertLease(); await this.db.metadataMigration.put({ id: kind, complete: true, requests: [] });
      this.fault(kind === "migration" ? "before-local-migration-commit" : "before-local-object-migration-commit");
    });
    this.fault(kind === "migration" ? "after-local-migration-commit" : "after-local-object-migration-commit");
  }

  async nextCoordinate(): Promise<RequestCoordinate | undefined> {
    const writer = await this.db.writerState.get("writer");
    if (!writer) return undefined;
    if (!Number.isSafeInteger(writer.next) || writer.next >= Number.MAX_SAFE_INTEGER) throw new Error("REQUEST_SEQUENCE_UNAVAILABLE");
    return { stream: writer.stream, number: writer.next };
  }

  async snapshotAnchors(snapshot: Snapshot): Promise<BaseAnchor[]> {
    if (snapshot.checkpoint === undefined) return [];
    if (snapshot.checkpoint > snapshot.boundary) throw new Error("INVALID_SNAPSHOT");
    const proofs = new Map((snapshot.bases ?? []).map(proof => [proof.revisionId, proof]));
    const heads = new Set(snapshot.files.flatMap(file => file.heads));
    if (proofs.size !== (snapshot.bases ?? []).length || proofs.size !== heads.size || snapshot.revisions.length !== heads.size) throw new Error("INVALID_SNAPSHOT");
    const anchors: BaseAnchor[] = [];
    for (const revision of snapshot.revisions) {
      const proof = proofs.get(revision.id);
      if (!heads.delete(revision.id) || !proof || proof.epoch !== snapshot.epoch || proof.boundary !== snapshot.boundary) throw new Error("BASE_ANCHOR_MISMATCH");
      const anchor = baseAnchorSchema.parse({ revision, proof }); await this.verify(anchor); anchors.push(anchor);
    }
    return anchors;
  }

  async coordinate(row: Outbox): Promise<RequestCoordinate> {
    if (row.coordinate) return row.coordinate;
    return this.db.transaction("rw", [this.db.leases, this.db.writerState, this.db.outbox], async () => {
      await this.assertLease(); const saved = await this.db.outbox.get(row.queueId!);
      if (!saved || saved.opId !== row.opId || canonical(saved.request) !== canonical(row.request)) throw new Error("OUTBOX_CHANGED");
      if (saved.coordinate) return saved.coordinate;
      const writer = await this.db.writerState.get("writer");
      if (!writer || !Number.isSafeInteger(writer.next) || writer.next >= Number.MAX_SAFE_INTEGER) throw new Error("REQUEST_SEQUENCE_UNAVAILABLE");
      const coordinate = { stream: writer.stream, number: writer.next++ };
      await this.db.writerState.put(writer); await this.db.outbox.update(row.queueId!, { coordinate });
      return coordinate;
    });
  }

  private async verify(anchor: BaseAnchor): Promise<void> {
    this.authenticate(anchor);
    const { revision, proof } = anchor;
    const progress = await this.db.progress.get("progress");
    if (progress && proof.epoch !== progress.epoch) throw new Error("BASE_ANCHOR_MISMATCH");
    if (proof.vaultId !== this.vaultId || proof.revisionId !== revision.id || proof.fileId !== revision.fileId ||
        proof.digest !== await revisionDigest(revision)) throw new Error("BASE_ANCHOR_MISMATCH");
    const existing = await this.db.revisions.get(revision.id);
    if (existing && canonical(existing) !== canonical(revision)) throw new Error("REVISION_CHANGED");
  }

  async ensureBase(revisionId: string): Promise<BaseProof> {
    const cached = await this.db.baseProofs.get(revisionId);
    if (cached) return cached.proof;
    return this.certify(revisionId);
  }
  private async certify(revisionId: string): Promise<BaseProof> {
    const revision = await this.db.revisions.get(revisionId); if (!revision) throw new Error("LOCAL_BASE_UNAVAILABLE");
    const anchor = await this.remote.certifyBase(revision); await this.verify(anchor);
    await this.db.transaction("rw", [this.db.leases, this.db.baseProofs, this.db.writerState], async () => {
      await this.assertLease(); const writer = await this.db.writerState.get("writer"); if (!writer) throw new Error("REQUEST_SEQUENCE_UNAVAILABLE");
      writer.highestServerSeq = Math.max(writer.highestServerSeq, anchor.proof.boundary);
      await this.db.writerState.put(writer); await this.db.baseProofs.put({ id: revision.id, proof: anchor.proof });
    });
    return anchor.proof;
  }
  private async bases(row: Outbox): Promise<BaseProof[]> {
    const proofs: BaseProof[] = [];
    for (const action of row.request.actions) if (action.type === "edit") proofs.push(await this.ensureBase(action.displayedRevision));
    return proofs;
  }

  async commit(row: Outbox) {
    const coordinate = await this.coordinate(row);
    const cached: BaseProof[] = [];
    for (const a of row.request.actions) if (a.type === "edit") { const saved = await this.db.baseProofs.get(a.displayedRevision); if (saved) cached.push(saved.proof); }
    try { return await this.remote.commitTracked(row.request, coordinate, cached); }
    catch (error) {
      if (!(error instanceof RemoteError) || error.code !== "BASE_PROOF_REQUIRED") throw error;
      return this.remote.commitTracked(row.request, coordinate, await this.bases(row));
    }
  }

  async complete(row: Outbox, result: Awaited<ReturnType<Transport["commitTracked"]>>): Promise<void> {
    const coordinate = await this.coordinate(row), { receipt } = result;
    if (receipt.opId !== row.opId || receipt.epoch !== row.request.epoch) throw new Error("RECEIPT_MISMATCH");
    const expected = new Set<string>();
    for (const a of row.request.actions) {
      if ("revisionId" in a) expected.add(a.revisionId);
      if (a.type === "resolve" && a.decision.kind === "keep-both") expected.add(a.decision.companion.revisionId);
    }
    if (result.bases.length !== expected.size) throw new Error("BASE_ANCHOR_MISMATCH");
    for (const anchor of result.bases) {
      if (!expected.delete(anchor.revision.id) || anchor.proof.epoch !== receipt.epoch || anchor.proof.boundary < receipt.seq) throw new Error("BASE_ANCHOR_MISMATCH");
      await this.verify(anchor);
    }
    await this.db.transaction("rw", [this.db.leases, this.db.outbox, this.db.writerState, this.db.baseProofs, this.db.revisions, this.db.requestAcks], async () => {
      await this.assertLease(); const saved = await this.db.outbox.get(row.queueId!);
      if (!saved || saved.opId !== row.opId || canonical(saved.request) !== canonical(row.request)) throw new Error("OUTBOX_CHANGED");
      const writer = await this.db.writerState.get("writer"); if (!writer || writer.stream !== coordinate.stream) throw new Error("REQUEST_STREAM_RECONCILIATION_REQUIRED");
      writer.highestServerSeq = Math.max(writer.highestServerSeq, receipt.seq, ...result.bases.map(a => a.proof.boundary));
      for (const a of result.bases) { await this.db.revisions.put(a.revision); await this.db.baseProofs.put({ id: a.revision.id, proof: a.proof }); }
      await this.db.writerState.put(writer);
      await this.db.requestAcks.put({ id: row.opId, ack: { ...coordinate, opId: row.opId, receipt } });
      await this.db.outbox.delete(row.queueId!);
      this.fault("before-local-request-ack-commit");
    });
    this.fault("after-local-request-ack-commit");
  }

  async acknowledgePending(): Promise<void> {
    for (const row of await this.db.requestAcks.toArray()) {
      await this.assertLease(); this.fault("before-request-ack-send");
      await this.remote.acknowledgeRequest(row.ack); this.fault("after-request-ack-send");
      await this.db.transaction("rw", [this.db.leases, this.db.requestAcks], async () => {
        await this.assertLease(); await this.db.requestAcks.delete(row.id);
      });
    }
  }
}
