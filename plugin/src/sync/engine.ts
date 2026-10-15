import { timerHost, type TimerHandle } from "../runtime/timers";
import { SYNC_FEATURES } from "../../../protocol/src/wire";
import { sharedConfig, hasDeviceFields } from "./config-projection";
import type { Action, Commit, FileState, Revision, Snapshot } from "../../../protocol/src/types";
import { canonical } from "../../../protocol/src/model";
import { VaultCrypto, MAX_FILE_BYTES, fingerprint, randomId, type SessionMaterial } from "./crypto";
import { SyncDB, type ApplyTask, type Inbox, type LocalFile, type Outbox } from "./store";
import { isAncestor, project } from "./projection";
import { RemoteError, Transport } from "./transport";
import { CHUNK_BYTES, SyncPolicy, fixedExclusion } from "./policy";

export interface FilePort {
  list(): Promise<string[]>;
  stat?(path: string): Promise<{ size: number } | null>;
  read(path: string): Promise<Uint8Array | null>;
  /** Create when expected=null; otherwise guard exact expected bytes. Text uses Vault.process. */
  write(path: string, desired: Uint8Array, expected: Uint8Array | null): Promise<void>;
  rename(from: string, to: string, expected: Uint8Array): Promise<void>;
  remove(path: string, expected: Uint8Array): Promise<void>;
  stageWrite(id: string, ciphertext: Uint8Array): Promise<void>;
  stageRead(id: string): Promise<Uint8Array>;
}
export interface EngineStatus { state: "locked" | "pending" | "needs-attention" | "complete"; outbox: number; inbox: number; conflicts: number; skipped?: number; errors: string[] }
export interface ReviewVersion { revision: string; device: string; deviceId?: string; kind: string; text: string | null; fingerprint: string; bytes: Uint8Array; length?: number }
export interface Review { fileId: string; path: string; heads: string[]; versions: ReviewVersion[]; location: FileState["location"] }
export interface RememberedMaterial { format: 0; vaultId: string; keyPackageFingerprint: string; session: SessionMaterial }

/** Foreground engine; host credentials and device enrollment remain outside this mobile-compatible core. */
export class SyncEngine {
  private keys?: VaultCrypto;
  private devices = new Map<string, string>();
  private busy = false;
  private owner = randomId();
  private errors: string[] = [];
  private stopping = false;
  private keyPackageFingerprint?: string;
  fault?: (point: string) => void;
  constructor(readonly db: SyncDB, private remote: Transport, private files: FilePort,
    readonly deviceId: string, readonly vaultId: string, private policy = new SyncPolicy()) {}
  setPolicy(policy: SyncPolicy): void { if (this.busy) throw new Error("SYNC_ALREADY_RUNNING"); this.policy = policy; }
  private async skip(path: string, reason: string): Promise<void> { await this.db.skipped.put({ id: path, path, reason }); }

  private async verifiedHandshake(onAuthenticated?: () => void) {
    if (this.busy) throw new Error("SYNC_ALREADY_RUNNING");
    const h = await this.remote.handshake();
    if (h.vaultId !== this.vaultId || !h.devices.some(d => d.id === this.deviceId) ||
        !SYNC_FEATURES.every(f => h.features.includes(f))) throw new Error("HANDSHAKE_MISMATCH");
    const previous = await this.db.progress.get("progress");
    if (previous && (previous.vaultId !== h.vaultId || previous.epoch !== h.epoch || previous.received > h.seq)) {
      throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
    }
    onAuthenticated?.();
    return h;
  }
  async unlock(passphrase: string, onAuthenticated?: () => void): Promise<void> {
    const h = await this.verifiedHandshake(onAuthenticated);
    const keys = await VaultCrypto.unlock(this.vaultId, h.keyPackage, passphrase);
    try { for (const revision of await this.db.revisions.toArray()) keys.manifest(revision); }
    catch { keys.close(); throw new Error("LOCAL_KEY_ANCHOR_MISMATCH"); }
    this.keys?.close(); this.keys = keys; this.devices = new Map(h.devices.map(d => [d.id, d.name]));
    this.keyPackageFingerprint = await fingerprint(new TextEncoder().encode(canonical(h.keyPackage)));
  }
  /** Read-only check for an already protected session: authenticate identity, rollback boundary and key-package anchor. */
  async validateConnection(onAuthenticated?: () => void): Promise<void> {
    this.crypto();
    const h = await this.verifiedHandshake(onAuthenticated);
    if (await fingerprint(new TextEncoder().encode(canonical(h.keyPackage))) !== this.keyPackageFingerprint) throw new Error("KEY_PACKAGE_CHANGED");
    this.devices = new Map(h.devices.map(d => [d.id, d.name]));
  }
  sealProfile(revision: number, value: unknown): string { return this.crypto().profileSeal(this.deviceId, revision, value); }
  openProfile(deviceId: string, revision: number, ciphertext: string): unknown { return this.crypto().profileOpen(deviceId, revision, ciphertext); }
  get unlocked(): boolean { return !!this.keys && !this.stopping; }
  rememberedMaterial(): RememberedMaterial {
    if (!this.keyPackageFingerprint) throw new Error("NO_KEY_ANCHOR");
    return { format: 0, vaultId: this.vaultId, keyPackageFingerprint: this.keyPackageFingerprint, session: this.crypto().sessionMaterial() };
  }
  async restoreRemembered(input: RememberedMaterial): Promise<void> {
    if (this.busy) throw new Error("SYNC_ALREADY_RUNNING");
    if (input.format !== 0 || input.vaultId !== this.vaultId || !/^[a-f0-9]{64}$/.test(input.keyPackageFingerprint)) throw new Error("INVALID_UNLOCK_MATERIAL");
    const progress = await this.db.progress.get("progress");
    if (progress && progress.vaultId !== this.vaultId) throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
    const keys = await VaultCrypto.restore(this.vaultId, input.session);
    try { for (const revision of await this.db.revisions.toArray()) keys.manifest(revision); }
    catch { keys.close(); throw new Error("LOCAL_KEY_ANCHOR_MISMATCH"); }
    this.keys?.close(); this.keys = keys; this.keyPackageFingerprint = input.keyPackageFingerprint;
    // Offline restore is allowed. sync() authenticates the remote identity/epoch/key-package before any I/O intent.
  }
  lock(): void { if (this.busy) { this.stopping = true; return; } this.keys?.close(); this.keys = undefined; }
  private crypto(): VaultCrypto { if (!this.keys || this.stopping) throw new Error("LOCKED"); return this.keys; }
  private ended(): void { this.busy = false; if (this.stopping) { this.stopping = false; this.lock(); } }
  private async lease(): Promise<void> {
    await this.db.transaction("rw", this.db.leases, async () => {
      const current = await this.db.leases.get("engine");
      if (current && current.owner !== this.owner && current.until > Date.now()) throw new Error("ANOTHER_LOCAL_INSTANCE_ACTIVE");
      await this.db.leases.put({ id: "engine", owner: this.owner, until: Date.now() + 60000 });
    });
  }
  private async checkLease(): Promise<void> {
    this.crypto();
    const row = await this.db.leases.get("engine");
    if (row?.owner !== this.owner || row.until <= Date.now()) throw new Error("LOCAL_LEASE_LOST");
  }
  private async initialize(epoch: string): Promise<void> {
    if (await this.db.progress.get("progress")) return;
    if (await this.db.localFiles.count() || await this.db.outbox.count()) throw new Error("LOCAL_STATE_INCOMPLETE");
    const snapshot = await this.remote.snapshot(); if (snapshot.epoch !== epoch) throw new Error("RECOVERY_RECONCILIATION_REQUIRED"); await this.acceptSnapshot(snapshot);
  }
  private async acceptSnapshot(s: Snapshot): Promise<void> {
    const keys = this.crypto();
    const previous = await this.db.progress.get("progress");
    if (previous && (s.epoch !== previous.epoch || s.boundary < previous.received)) throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
    // Current protocol retains tombstones and revision history; a snapshot cannot forget a known identity.
    for (const f of await this.db.remoteFiles.toArray()) if (!s.files.some(next => next.id === f.id)) throw new Error("INCOMPLETE_SNAPSHOT");
    for (const r of s.revisions) keys.manifest(r);
    for (const f of s.files) { keys.path(f.id, f.location); if (f.heads.some(h => !s.revisions.some(r => r.id === h && r.fileId === f.id))) throw new Error("INVALID_SNAPSHOT"); }
    await this.db.transaction("rw", [this.db.leases, this.db.remoteFiles, this.db.revisions, this.db.inbox, this.db.progress], async () => {
      await this.checkLease();
      await this.db.remoteFiles.clear(); await this.db.inbox.clear();
      await this.db.remoteFiles.bulkPut(s.files); await this.db.revisions.bulkPut(s.revisions);
      await this.db.inbox.put({ seq: s.boundary, fileIds: s.files.map(f => f.id), done: false });
      await this.db.progress.put({ id: "progress", vaultId: this.vaultId, epoch: s.epoch, received: s.boundary, applied: previous?.applied ?? 0 });
      this.fault?.("before-snapshot-commit");
    });
    this.fault?.("after-snapshot-commit");
  }
  private async request(actions: Action[]): Promise<Commit> {
    const p = await this.db.progress.get("progress"); if (!p) throw new Error("NOT_INITIALIZED");
    return { protocol: 0, vaultId: this.vaultId, epoch: p.epoch, requiredFeatures: [...SYNC_FEATURES], deviceId: this.deviceId, opId: randomId(), actions };
  }
  private async enqueue(request: Commit, local: LocalFile[], revisions: Revision[], objects: Outbox["objects"]): Promise<void> {
    // All ciphertext snapshots have already been staged before the short DB transaction.
    await this.checkLease();
    await this.db.transaction("rw", [this.db.leases, this.db.localFiles, this.db.revisions, this.db.outbox], async () => {
      await this.checkLease();
      await this.db.localFiles.bulkPut(local); await this.db.revisions.bulkPut(revisions);
      await this.db.outbox.add({ opId: request.opId, request, objects });
      this.fault?.("before-outbox-commit");
    });
    this.fault?.("after-outbox-commit");
  }
  private async captureOne(path: string, bytes: Uint8Array | null, local?: LocalFile): Promise<void> {
    const keys = this.crypto(); if (bytes && bytes.length > MAX_FILE_BYTES) { this.errors.push(`FILE_TOO_LARGE: ${path}`); return; }
    if (local && await this.db.applyTasks.get(local.id)) return;
    if (!bytes && (!local || local.deleted)) return;
    const fp = await fingerprint(bytes ?? new Uint8Array());
    if (local && local.fingerprint === fp && local.deleted === (bytes === null)) return;
    let independent: FileState | undefined;
    if (!local && bytes) {
      const samePath = (await this.db.remoteFiles.toArray()).find(f => keys.pathKey(path) === f.location.pathKey);
      if (samePath) {
        if (samePath.heads.length === 1) {
          const revision = await this.db.revisions.get(samePath.heads[0]!);
          if (revision && revision.payload.kind === "file" && keys.manifest(revision).fingerprint === fp) {
            await this.db.localFiles.put({ id: samePath.id, path, location: samePath.location, revision: revision.id, fingerprint: fp, deleted: false }); return;
          }
        }
        // Preserve untracked bytes as an independent root; never invent a displayed parent.
        independent = samePath;
      }
    }
    const fileId = local?.id ?? independent?.id ?? randomId(); const revisionId = randomId(); const parents = local ? [local.revision] : [];
    const kind = bytes === null ? "deleted" : "file";
    const objects: Outbox["objects"] = []; let objectIds: string[] = [];
    if (bytes) {
      for (let offset = 0; offset < Math.max(1, bytes.length); offset += CHUNK_BYTES) {
        const obj = keys.object(bytes.subarray(offset, offset + CHUNK_BYTES)); await this.files.stageWrite(obj.id, obj.bytes); objects.push({ id: obj.id, stage: obj.id }); objectIds.push(obj.id);
      }
    }
    this.fault?.("after-capture-stage");
    const r: Revision = { id: revisionId, fileId, parents, deviceId: this.deviceId, payload: await keys.payload({ id: revisionId, fileId, parents, deviceId: this.deviceId }, bytes ?? new Uint8Array(), kind, objectIds) };
    const location = local?.location ?? independent?.location ?? keys.location(fileId, path);
    const action: Action = local
      ? { type: "edit", fileId, revisionId, displayedRevision: local.revision, payload: r.payload }
      : independent ? { type: "branch", fileId, revisionId, payload: r.payload } : { type: "create", fileId, revisionId, payload: r.payload, location };
    await this.enqueue(await this.request([action]), [{ id: fileId, path, revision: revisionId, fingerprint: fp, deleted: bytes === null, location }], [r], objects);
  }
  private async capture(): Promise<void> {
    const paths = await this.files.list(); // Throws on scan errors; never translate a failed scan to deletions.
    const locals = await this.db.localFiles.toArray(); const byPath = new Map(locals.map(f => [f.path, f]));
    for (const path of paths) {
      try {
        const stat = await this.files.stat?.(path);
        const reason = this.policy.reason(path, stat?.size); if (reason) { await this.skip(path, reason); continue; }
        this.crypto().pathKey(path); const bytes = await this.files.read(path);
        if (bytes && this.policy.reason(path, bytes.length)) { await this.skip(path, this.policy.reason(path, bytes.length)!); continue; }
        if (bytes === null) { this.errors.push(`SCAN_CHANGED: ${path}`); continue; }
        await this.captureOne(path, bytes, byPath.get(path));
      } catch (error) { const message = error instanceof Error ? error.message : String(error); if (message.includes("LEASE") || message === "LOCKED") throw error; this.errors.push(message); }
    }
    const set = new Set(paths);
    for (const f of locals) if (!set.has(f.path) && !f.deleted) {
      const reason = this.policy.reason(f.path); if (reason) { await this.skip(f.path, reason); continue; }
      // A second successful absence check is required, never an I/O exception.
      try { if (await this.files.read(f.path) === null) await this.captureOne(f.path, null, f); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); if (message.includes("LEASE") || message === "LOCKED") throw error; this.errors.push(message); }
    }
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    if (!this.keys || this.busy) throw new Error("RENAME_CAPTURE_REQUIRES_IDLE_UNLOCKED_ENGINE");
    this.busy = true;
    try {
      await this.lease(); const f = await this.db.localFiles.where("path").equals(oldPath).first(); if (!f) return;
      if (await this.db.applyTasks.get(f.id)) throw new Error("APPLY_IN_PROGRESS");
      if (fixedExclusion(newPath)) { await this.db.localFiles.update(f.id, { path: newPath }); return; }
      const location = this.crypto().location(f.id, newPath);
      await this.enqueue(await this.request([{ type: "move", fileId: f.id, expectedLocation: f.location.revision, location }]), [{ ...f, path: newPath, location }], [], []);
    } finally { await this.endRun(); }
  }
  private async flush(): Promise<void> {
    await this.checkLease();
    const blocked = new Set<string>();
    outgoing: for (const row of await this.db.outbox.orderBy("queueId").toArray()) {
      await this.checkLease();
      let excluded = false;
      for (const action of row.request.actions) {
        const local = await this.db.localFiles.get(action.fileId);
        const path = action.type === "create" || action.type === "move" ? this.crypto().path(action.fileId, action.location) : local?.path;
        const revision = "revisionId" in action ? await this.db.revisions.get(action.revisionId) : undefined;
        const reason = path ? this.policy.reason(path, revision ? this.crypto().manifest(revision).length : undefined) : "UNKNOWN_OUTBOX_PATH";
        if (reason || blocked.has(action.fileId)) { excluded = true; blocked.add(action.fileId); if (path) await this.skip(path, reason ?? "依赖被排除的待上传操作"); }
      }
      if (excluded) { for (const a of row.request.actions) blocked.add(a.fileId); await this.db.outbox.update(row.queueId!, { error: "EXCLUDED_BY_RULE" }); continue; }
      await this.db.outbox.update(row.queueId!, { error: undefined });
      try {
        // Ask for the immutable receipt first: an accepted operation no longer depends on local stages.
        let receipt;
        try { receipt = await this.remote.commit(row.request); }
        catch (error) {
          if (!(error instanceof RemoteError) || error.code !== "OBJECT_MISSING") throw error;
          for (const obj of row.objects) {
            let bytes: Uint8Array;
            // Never poison an immutable remote object ID with damaged local ciphertext.
            try { bytes = await this.files.stageRead(obj.stage); this.crypto().decryptObject(obj.id, bytes).fill(0); }
            catch (stageError) {
              if (!this.unlocked) throw stageError;
              await this.db.outbox.update(row.queueId!, { error: "UPLOAD_STAGE_UNAVAILABLE" });
              this.errors.push("UPLOAD_STAGE_UNAVAILABLE"); continue outgoing;
            }
            await this.checkLease(); await this.remote.upload(obj.id, bytes); this.fault?.("after-object-upload");
          }
          await this.checkLease(); receipt = await this.remote.commit(row.request);
        }
        if (receipt.opId !== row.opId || receipt.epoch !== row.request.epoch) throw new Error("RECEIPT_MISMATCH");
        this.fault?.("after-remote-commit"); await this.db.outbox.delete(row.queueId!);
        this.fault?.("after-outbox-ack");
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error;
        if (error.code === "REVIEW_STALE") {
          // Keep the rejected immutable intent for inspection; it must never be replayed as a fresh decision.
          await this.db.transaction("rw", [this.db.outbox, this.db.rejectedOutbox], async () => {
            await this.db.rejectedOutbox.put({ ...row, error: error.code }); await this.db.outbox.delete(row.queueId!);
          });
        } else await this.db.outbox.update(row.queueId!, { error: error.code });
        this.errors.push(error.code);
        // Keep immutable intent; unrelated files may still be submitted.
      }
    }
  }
  private async reconcileInitialCollisions(): Promise<boolean> {
    let changed = false;
    for (const row of await this.db.outbox.toArray()) {
      if (row.error !== "PATH_OCCUPIED" || row.request.actions.length !== 1) continue;
      const action = row.request.actions[0]!; if (action.type !== "create") continue;
      const local = await this.db.localFiles.get(action.fileId); if (!local || local.deleted || this.policy.reason(local.path)) continue;
      const remote = (await this.db.remoteFiles.toArray()).find(f => f.location.pathKey === action.location.pathKey && f.id !== action.fileId);
      if (!remote || await this.db.remoteFiles.get(action.fileId) || this.crypto().path(remote.id, remote.location) !== local.path) continue;
      const pending = (await this.db.outbox.toArray()).filter(r => r.request.actions.some(a => a.fileId === action.fileId));
      if (pending.some(r => r.request.actions.length !== 1 || r.request.actions[0]!.type === "move")) continue;
      const bytes = await this.files.read(local.path); if (!bytes || this.policy.reason(local.path, bytes.length)) continue;
      const tasks = (await this.db.applyTasks.toArray()).filter(t => t.id === remote.id && t.sourcePath === local.path && t.targetPath === local.path);
      // PATH_OCCUPIED proves this create was rejected. Archive immutable intents/journals before changing identity.
      await this.db.transaction("rw", [this.db.reconciliations, this.db.rejectedOutbox, this.db.outbox, this.db.localFiles, this.db.applyTasks, this.db.conflicts], async () => {
        await this.db.reconciliations.put({ id: action.fileId, reason: "INITIAL_PATH_COLLISION", local, outbox: pending, tasks });
        for (const intent of pending) { await this.db.rejectedOutbox.put({ ...intent, error: "INITIAL_PATH_COLLISION" }); await this.db.outbox.delete(intent.queueId!); }
        await this.db.localFiles.delete(action.fileId);
        for (const task of tasks) await this.db.applyTasks.delete(task.id);
        await this.db.conflicts.delete(remote.id);
      });
      this.fault?.("after-collision-archive");
      // Exact matching bytes may adopt the remote revision; otherwise import an independent root, never a guessed parent.
      await this.captureOne(local.path, bytes, undefined); changed = true;
    }
    if (!(await this.db.outbox.toArray()).some(r => r.error === "PATH_OCCUPIED")) this.errors = this.errors.filter(e => e !== "PATH_OCCUPIED");
    return changed;
  }
  private async receive(): Promise<void> {
    for (;;) {
      const p = (await this.db.progress.get("progress"))!;
      let changes;
      try { changes = await this.remote.changes(p.epoch, p.received); }
      catch (error) {
        if (!(error instanceof RemoteError) || error.code !== "NEED_SNAPSHOT") throw error;
        await this.checkLease(); const snapshot = await this.remote.snapshot();
        if (snapshot.boundary <= p.received) throw new Error("SNAPSHOT_NO_PROGRESS");
        await this.acceptSnapshot(snapshot); continue;
      }
      if (!changes.length) return;
      const files = new Map((await this.db.remoteFiles.toArray()).map(f => [f.id, f]));
      const revisions = new Map((await this.db.revisions.toArray()).map(r => [r.id, r]));
      const tasks: Inbox[] = []; let seq = p.received;
      for (const change of changes) {
        if (change.seq !== seq + 1) throw new Error("LOG_GAP");
        const ids = project(files, revisions, change);
        for (const id of ids) { const f = files.get(id)!; this.crypto().path(f.id, f.location); }
        tasks.push({ seq: change.seq, fileIds: ids, done: false, change }); seq = change.seq;
      }
      // Authenticate every new/locally staged revision before recording a receive boundary.
      for (const r of revisions.values()) this.crypto().manifest(r);
      await this.checkLease();
      await this.db.transaction("rw", [this.db.leases, this.db.remoteFiles, this.db.revisions, this.db.inbox, this.db.progress], async () => {
        await this.checkLease();
        if ((await this.db.progress.get("progress"))?.received !== p.received) throw new Error("RECEIVE_BASELINE_CHANGED");
        await this.db.remoteFiles.bulkPut([...files.values()]); await this.db.revisions.bulkPut([...revisions.values()]);
        await this.db.inbox.bulkPut(tasks); await this.db.progress.put({ ...p, received: seq });
        this.fault?.("before-inbox-commit");
      });
      this.fault?.("after-inbox-commit");
      if (changes.length < 100) return;
    }
  }
  private async bytes(r: Revision): Promise<Uint8Array> {
    const manifest = this.crypto().manifest(r); const bytes = new Uint8Array(manifest.length); let offset = 0;
    for (const id of r.payload.objects) {
      const part = this.crypto().decryptObject(id, await this.remote.object(id));
      if (offset + part.length > bytes.length) throw new Error("MANIFEST_CONTENT_MISMATCH");
      bytes.set(part, offset); offset += part.length;
    }
    if (offset !== manifest.length || await fingerprint(bytes) !== manifest.fingerprint) throw new Error("MANIFEST_CONTENT_MISMATCH"); return bytes;
  }

  private async finish(task: ApplyTask): Promise<void> {
    await this.db.transaction("rw", [this.db.leases, this.db.localFiles, this.db.applyTasks, this.db.conflicts], async () => {
      this.crypto();
      const lease = await this.db.leases.get("engine");
      if (lease?.owner !== this.owner || lease.until <= Date.now()) throw new Error("LOCAL_LEASE_LOST");
      if ((await this.db.applyTasks.get(task.id))?.stage !== task.stage) throw new Error("APPLY_TASK_CHANGED");
      await this.db.localFiles.put({ id: task.id, path: task.targetPath, location: task.location, revision: task.revision, fingerprint: task.desiredFingerprint, deleted: task.deleted });
      await this.db.applyTasks.delete(task.id); await this.db.conflicts.delete(task.id);
      this.fault?.("before-apply-ack");
    });
    this.fault?.("after-apply-ack");
  }
  private async applyTask(task: ApplyTask): Promise<boolean> {
    await this.checkLease();
    const reason = this.policy.reason(task.sourcePath, task.size) ?? this.policy.reason(task.targetPath, task.size);
    if (reason) { await this.skip(task.targetPath, reason); return false; }
    const owner = await this.db.localFiles.where("path").equals(task.targetPath).first();
    if (owner && owner.id !== task.id) { await this.db.conflicts.put({ id: task.id, path: task.targetPath, heads: [task.revision], reason: "INITIAL_PATH_COLLISION" }); return false; }
    const source = await this.files.read(task.sourcePath);
    const target = task.targetPath === task.sourcePath ? source : await this.files.read(task.targetPath);
    if (task.deleted && source === null) { await this.finish(task); return true; }
    if (!task.deleted && target && await fingerprint(target) === task.desiredFingerprint &&
        (task.sourcePath === task.targetPath || source === null)) { await this.finish(task); return true; }
    const expected = task.sourcePath === task.targetPath || source !== null ? source : target;
    const expectedFp = expected === null ? null : await fingerprint(expected);
    if (expectedFp !== task.oldFingerprint || (task.sourcePath !== task.targetPath && source !== null && target !== null)) {
      await this.db.conflicts.put({ id: task.id, path: task.targetPath, heads: [task.revision], reason: "LOCAL_CHANGED_DURING_APPLY: preserve bytes and journal" }); return false;
    }
    const desired = this.crypto().localOpen(task.stage, await this.files.stageRead(task.stage));
    if (await fingerprint(desired) !== task.desiredFingerprint) throw new Error("STAGE_CORRUPT");
    await this.checkLease();
    if (task.deleted) { if (source) await this.files.remove(task.sourcePath, source); }
    else {
      if (task.sourcePath !== task.targetPath && source !== null) { await this.files.rename(task.sourcePath, task.targetPath, source); this.fault?.("after-vault-rename"); await this.checkLease(); }
      await this.files.write(task.targetPath, desired, expected);
    }
    this.fault?.("after-vault-write"); await this.finish(task); return true;
  }
  private async recover(): Promise<void> {
    for (const task of await this.db.applyTasks.toArray()) {
      try { await this.applyTask(task); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); if (message.includes("LEASE") || message === "LOCKED") throw error; this.errors.push(`APPLY_RECOVERY_FAILED: ${task.targetPath}`); }
    }
  }
  private async apply(): Promise<void> {
    const remote = await this.db.remoteFiles.toArray();
    const revisions = new Map((await this.db.revisions.toArray()).map(r => [r.id, r]));
    const settled = new Set<string>();
    for (const f of remote) {
      try {
        const path = this.crypto().path(f.id, f.location);
        const lengths = f.heads.map(id => this.crypto().manifest(revisions.get(id)!).length);
        const reason = this.policy.reason(path, Math.max(...lengths));
        if (reason) { await this.skip(path, reason); settled.add(f.id); continue; }
        if (f.entryKind !== "file") { this.errors.push(`DIRECTORY_APPLY_NOT_IMPLEMENTED: ${path}`); continue; }
        if (f.heads.length > 1) { await this.db.conflicts.put({ id: f.id, path, heads: f.heads, reason: "CONCURRENT_REVISIONS" }); continue; }
        if (await this.db.applyTasks.get(f.id)) continue;
        const r = revisions.get(f.heads[0]!)!; const local = await this.db.localFiles.get(f.id);
        const owner = await this.db.localFiles.where("path").equals(path).first();
        if (owner && owner.id !== f.id) { await this.db.conflicts.put({ id: f.id, path, heads: f.heads, reason: "INITIAL_PATH_COLLISION" }); continue; }
        const sourcePath = local?.path ?? path;
        const stat = await this.files.stat?.(sourcePath);
        const sourceReason = this.policy.reason(sourcePath, stat?.size);
        if (sourceReason) { await this.skip(path, sourceReason); settled.add(f.id); continue; }
        const current = await this.files.read(sourcePath);
        const currentFp = current === null ? null : await fingerprint(current);
        if (local && !isAncestor(local.revision, r.id, revisions)) continue; // Preserve unsent/other causal branches.
        if (local && local.revision === r.id && local.location.revision === f.location.revision && currentFp === (local.deleted ? null : local.fingerprint)) { settled.add(f.id); await this.db.conflicts.delete(f.id); continue; }
        const desired = await this.bytes(r); const desiredFp = await fingerprint(desired);
        const deleted = r.payload.kind === "deleted";
        if (local && currentFp !== (local.deleted ? null : local.fingerprint)) {
          await this.db.conflicts.put({ id: f.id, path, heads: f.heads, reason: "LOCAL_CHANGED_BEFORE_APPLY" }); continue;
        }
        if (!local && current !== null && (deleted || currentFp !== desiredFp)) {
          await this.db.conflicts.put({ id: f.id, path, heads: f.heads, reason: "UNTRACKED_LOCAL_CONTENT" }); continue;
        }
        const stage = randomId(); await this.files.stageWrite(stage, this.crypto().localSeal(stage, desired));
        let backup: string | undefined;
        if (current) { backup = randomId(); await this.files.stageWrite(backup, this.crypto().localSeal(backup, current)); }
        const task: ApplyTask = { id: f.id, sourcePath, targetPath: path, oldFingerprint: currentFp, desiredFingerprint: desiredFp, revision: r.id, location: f.location, deleted, stage, size: desired.length };
        if (backup) task.backup = backup;
        this.fault?.("after-apply-stage");
        await this.checkLease(); await this.db.applyTasks.put(task); this.fault?.("after-apply-prepare");
        if (await this.applyTask(task)) settled.add(f.id);
      } catch (error) { const message = error instanceof Error ? error.message : String(error); if (message.includes("LEASE") || message === "LOCKED") throw error; this.errors.push(message); }
    }
    await this.db.transaction("rw", [this.db.leases, this.db.inbox, this.db.progress], async () => {
      await this.checkLease();
      const tasks = await this.db.inbox.orderBy("seq").toArray(); const p = (await this.db.progress.get("progress"))!;
      let applied = p.applied;
      for (const task of tasks) {
        if (task.fileIds.every(id => settled.has(id))) { task.done = true; await this.db.inbox.put(task); }
      }
      // Snapshot bootstrap may jump directly to its frozen boundary, then regular groups are contiguous.
      for (const task of tasks) { if (task.seq < applied) continue; if (!task.done) break; applied = task.seq; }
      await this.db.progress.put({ ...p, applied });
      this.fault?.("before-applied-cursor-commit");
    });
    this.fault?.("after-applied-cursor-commit");
  }
  private async release(): Promise<void> {
    await this.db.transaction("rw", this.db.leases, async () => { if ((await this.db.leases.get("engine"))?.owner === this.owner) await this.db.leases.delete("engine"); });
  }
  private async endRun(): Promise<void> { try { await this.release(); } finally { this.ended(); } }
  async sync(): Promise<EngineStatus> {
    if (this.busy) throw new Error("SYNC_ALREADY_RUNNING"); this.crypto(); this.busy = true; this.errors = [];
    let heartbeat: TimerHandle | undefined;
    const renewals = new Set<Promise<void>>();
    try {
      await this.lease(); await this.db.skipped.clear();
      heartbeat = timerHost().setInterval(() => {
        const renewal = this.lease().catch(() => { this.stopping = true; }); renewals.add(renewal);
        void renewal.finally(() => renewals.delete(renewal));
      }, 10000);
      const h = await this.remote.handshake(); if (!SYNC_FEATURES.every(f => h.features.includes(f))) throw new Error("SERVER_UPGRADE_REQUIRED"); const p = await this.db.progress.get("progress");
      if (h.vaultId !== this.vaultId || (p && (p.epoch !== h.epoch || p.received > h.seq))) throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
      if (await fingerprint(new TextEncoder().encode(canonical(h.keyPackage))) !== this.keyPackageFingerprint) throw new Error("KEY_PACKAGE_CHANGED");
      this.devices = new Map(h.devices.map(d => [d.id, d.name]));
      await this.initialize(h.epoch); await this.receive(); await this.reconcileInitialCollisions(); await this.recover(); await this.capture(); await this.flush(); await this.receive();
      if (await this.reconcileInitialCollisions()) { await this.flush(); await this.receive(); }
      await this.apply();
    } catch (error) { this.errors.push(error instanceof Error ? error.message : String(error)); }
    finally {
      timerHost().clearInterval(heartbeat); await Promise.all(renewals);
      try { await this.endRun(); } catch { this.errors.push("LEASE_RELEASE_FAILED"); }
    }
    return this.status();
  }
  async status(): Promise<EngineStatus> {
    const [outgoing, tasks, conflictRows, applyRows, skips] = await Promise.all([this.db.outbox.toArray(), this.db.inbox.toArray(), this.db.conflicts.toArray(), this.db.applyTasks.toArray(), this.db.skipped.toArray()]);
    const skippedPaths = new Set(skips.map(s => s.path));
    const conflicts = conflictRows.filter(c => !this.policy.reason(c.path) && !skippedPaths.has(c.path)).length;
    const outbox = outgoing.filter(r => r.error !== "EXCLUDED_BY_RULE").length;
    const apply = applyRows.filter(t => !this.policy.reason(t.sourcePath, t.size) && !this.policy.reason(t.targetPath, t.size)).length;
    const inbox = tasks.filter(t => !t.done).length + apply;
    const state = !this.keys ? "locked" : conflicts || this.errors.length ? "needs-attention" : outbox || inbox ? "pending" : "complete";
    return { state, outbox, inbox, conflicts, skipped: skips.length, errors: [...this.errors] };
  }

  async saveMergeDraft(fileId: string, text: string): Promise<void> { const bytes = new TextEncoder().encode(text); if (bytes.length > 65536) throw new Error("MERGE_TOO_LARGE"); const ciphertext = this.crypto().localSeal(`merge:${fileId}`, bytes); await this.db.mergeDrafts.put({ id: fileId, ciphertext }); }
  async loadMergeDraft(fileId: string): Promise<string | null> { const draft = await this.db.mergeDrafts.get(fileId); return draft ? new TextDecoder("utf-8", { fatal: true }).decode(this.crypto().localOpen(`merge:${fileId}`, draft.ciphertext)) : null; }
  async review(fileId: string): Promise<Review> {
    const f = await this.db.remoteFiles.get(fileId); if (!f || f.heads.length < 2) throw new Error("NO_REMOTE_CONFLICT");
    const versions: ReviewVersion[] = []; const path = this.crypto().path(f.id, f.location);
    for (const head of f.heads) {
      const r = (await this.db.revisions.get(head))!; const manifest = this.crypto().manifest(r);
      if (manifest.length > 65536 || !/\.(md|txt|json|canvas|css|js|ts|ya?ml|xml|html|csv)$/i.test(path)) { versions.push({ revision: head, device: this.devices.get(r.deviceId) ?? r.deviceId, deviceId: r.deviceId, kind: r.payload.kind, text: null, fingerprint: manifest.fingerprint, bytes: new Uint8Array(), length: manifest.length }); continue; }
      const bytes = await this.bytes(r); let text: string | null = null;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (text.includes("\u0000")) text = null; } catch { /* binary */ }
      versions.push({ revision: head, device: this.devices.get(r.deviceId) ?? r.deviceId, deviceId: r.deviceId, kind: r.payload.kind, text, fingerprint: await fingerprint(bytes), bytes });
    }
    return { fileId, path: this.crypto().path(f.id, f.location), heads: [...f.heads], versions, location: f.location };
  }
  async resolve(review: Review, selectedRevision: string, companionPath?: string, mergedBytes?: Uint8Array): Promise<void> {
    if (this.busy) throw new Error("SYNC_ALREADY_RUNNING"); this.busy = true; this.errors = [];
    review = structuredClone(review); mergedBytes = mergedBytes?.slice();
    try {
      if (mergedBytes && review.path.startsWith(".obsidian/") && review.path.endsWith(".json")) { if (hasDeviceFields(review.path, mergedBytes)) throw new Error("MERGE_CONTAINS_DEVICE_FIELDS"); mergedBytes = sharedConfig(review.path, mergedBytes); }
      await this.lease();
      // Freeze displayed review; flush+receive updates the CURRENT set without silently changing the chosen snapshot.
      await this.capture(); await this.flush(); await this.receive();
      const f = await this.db.remoteFiles.get(review.fileId);
      if (!f || f.location.revision !== review.location.revision || canonical([...f.heads].sort()) !== canonical([...review.heads].sort())) throw new Error("REVIEW_STALE");
      if (this.policy.reason(review.path)) throw new Error("FILE_EXCLUDED");
      if (mergedBytes && (mergedBytes.length > this.policy.maxBytes || mergedBytes.length > 65536 || companionPath)) throw new Error("INVALID_MERGE");
      const selected = mergedBytes ? { revision: "", bytes: mergedBytes, kind: "file" } : review.versions.find(v => v.revision === selectedRevision); if (!selected) throw new Error("INVALID_SELECTION");
      const source = mergedBytes ? undefined : (await this.db.revisions.get(selectedRevision))!; const revisionId = randomId();
      if (source && await fingerprint(selected.bytes) !== this.crypto().manifest(source).fingerprint) throw new Error("REVIEW_BYTES_CHANGED");
      const objects: Outbox["objects"] = []; let objectIds = source?.payload.objects ?? [];
      if (mergedBytes) { const obj = this.crypto().object(mergedBytes); await this.files.stageWrite(obj.id, obj.bytes); objects.push({ id: obj.id, stage: obj.id }); objectIds = [obj.id]; }
      const base = { id: revisionId, fileId: f.id, parents: review.heads, deviceId: this.deviceId, ...(source ? { selectedFrom: source.id } : {}) };
      const revision: Revision = { ...base, payload: await this.crypto().payload(base, selected.bytes, source?.payload.kind ?? "file", objectIds) };
      const action: Extract<Action, { type: "resolve" }> = { type: "resolve", fileId: f.id, expectedLocation: review.location.revision, observedHeads: review.heads, revisionId, payload: revision.payload, decision: source ? { kind: "select", selectedRevision } : { kind: "manual" } };
      if (companionPath) {
        if (review.versions.length !== 2) throw new Error("KEEP_BOTH_REQUIRES_TWO_HEADS"); this.crypto().pathKey(companionPath);
        if (this.policy.reason(companionPath, selected.bytes.length) || (await this.files.read(companionPath)) !== null || companionPath.normalize("NFC").toLowerCase() === review.path.normalize("NFC").toLowerCase()) throw new Error("COMPANION_PATH_UNAVAILABLE");
        const other = review.versions.find(v => v.revision !== selectedRevision)!; const original = (await this.db.revisions.get(other.revision))!;
        if (await fingerprint(other.bytes) !== this.crypto().manifest(original).fingerprint) throw new Error("REVIEW_BYTES_CHANGED");
        if (original.payload.kind === "deleted") throw new Error("EXPORT_DELETE_CONFLICT_MANUALLY");
        const companionId = randomId(); const id = randomId();
        const payload = await this.crypto().payload({ id, fileId: companionId, parents: [], deviceId: this.deviceId, selectedFrom: original.id }, other.bytes, original.payload.kind, original.payload.objects);
        action.decision = { kind: "keep-both", selectedRevision, companionSource: original.id, companion: { type: "create", fileId: companionId, revisionId: id, payload, location: this.crypto().location(companionId, companionPath) } };
      }
      // Persist exact immutable resolution before network; retry retains IDs and ciphertext.
      const request = await this.request([action]); await this.enqueue(request, [], [revision], objects);
      await this.flush(); await this.receive();
      const rejected = await this.db.rejectedOutbox.get(request.opId);
      if (rejected) throw new RemoteError(rejected.error ?? "REVIEW_STALE");
      const pending = await this.db.outbox.where("opId").equals(request.opId).first();
      if (pending) throw new RemoteError(pending.error ?? "RESOLUTION_NOT_COMMITTED");
      // Acknowledged explicit selection authorizes replacement only if the local file still matches the review snapshot.
      const current = await this.db.localFiles.get(f.id); const bytes = current ? await this.files.read(current.path) : null;
      if (current && (bytes === null ? current.deleted : await fingerprint(bytes) === current.fingerprint)) {
        const remoteHead = (await this.db.remoteFiles.get(f.id))?.heads;
        if (remoteHead?.length === 1 && remoteHead[0] === revisionId) {
          const desired = selected.bytes; const stage = randomId(); await this.files.stageWrite(stage, this.crypto().localSeal(stage, desired));
          const task: ApplyTask = { id: f.id, sourcePath: current.path, targetPath: this.crypto().path(f.id, f.location), oldFingerprint: bytes === null ? null : await fingerprint(bytes), desiredFingerprint: await fingerprint(desired), revision: revisionId, location: f.location, deleted: revision.payload.kind === "deleted", stage, size: desired.length };
          if (bytes) { task.backup = randomId(); await this.files.stageWrite(task.backup, this.crypto().localSeal(task.backup, bytes)); }
          await this.db.applyTasks.put(task); await this.applyTask(task);
        }
      }
      await this.apply(); await this.db.mergeDrafts.delete(review.fileId);
    } finally { await this.endRun(); }
  }
}
