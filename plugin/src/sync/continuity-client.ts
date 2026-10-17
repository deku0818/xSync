import { randomId } from "./crypto";
import type { SyncDB } from "./store";
import { RemoteError, type Transport, type HTTPResponse, type ContinuityGuard } from "./transport";

/** One durable confirmed token and, at most, one pending transition. A confirmed response is
 * persisted BEFORE the caller can accept metadata, remove an outbox, or touch Vault bytes. */
export class ContinuityClient {
  constructor(private db: SyncDB, private remote: Transport, private assertLease: () => Promise<void>, private fault: (point: string) => void) {}

  async initialize(): Promise<void> {
    const token = await this.remote.continuityToken();
    const existing = await this.db.continuity.get("continuity");
    if (existing) await this.resolve(token);
    else {
      await this.db.transaction("rw", [this.db.leases, this.db.continuity, this.db.progress, this.db.localFiles, this.db.revisions, this.db.outbox], async () => {
        await this.assertLease();
        const local = await this.db.continuity.get("continuity");
        if (local) throw new Error("CONTINUITY_STATE_CHANGED");
        const bootstrap = !!await this.db.progress.count() || !!await this.db.localFiles.count() || !!await this.db.revisions.count() || !!await this.db.outbox.count();
        await this.db.continuity.put({ id: "continuity", token, bootstrap });
      });
    }
    this.remote.setContinuityGuard(send => this.protect(send));
  }

  private async reconcile(server: string): Promise<void> {
    const local = await this.db.continuity.get("continuity");
    if (!local) throw new Error("CONTINUITY_STATE_MISSING");
    if (server === local.token) { if (local.pending) throw new Error("CONTINUITY_TRANSITION_UNCONFIRMED"); return; }
    if (server === local.pending) { local.token = server; delete local.pending; await this.db.continuity.put(local); return; }
    throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
  }

  private async resolve(observed?: string): Promise<void> {
    let server = observed ?? await this.remote.continuityToken();
    const local = await this.db.continuity.get("continuity");
    if (local?.pending && server === local.token) {
      try {
        const fenced = await this.remote.fenceContinuity(local.token, local.pending);
        if (fenced !== local.pending) throw new Error("CONTINUITY_RESPONSE_MISMATCH");
        server = fenced;
      } catch (error) {
        if (!(error instanceof RemoteError) || error.code !== "CONTINUITY_MISMATCH") throw error;
        server = await this.remote.continuityToken();
      }
    }
    await this.db.transaction("rw", [this.db.leases, this.db.continuity], async () => { await this.assertLease(); await this.reconcile(server); });
  }

  private async protect(send: Parameters<ContinuityGuard>[0]): Promise<HTTPResponse> {
    if ((await this.db.continuity.get("continuity"))?.pending) await this.resolve();
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await this.db.transaction("rw", [this.db.leases, this.db.continuity], async () => {
        await this.assertLease(); const local = await this.db.continuity.get("continuity");
        if (!local || local.pending) throw new Error("CONTINUITY_STATE_CHANGED");
        local.pending = randomId(); await this.db.continuity.put(local); return local;
      });
      this.fault("after-continuity-intent-commit");
      // Network failure leaves the pending transition intact, including requests still in flight.
      const result = await send({ "X-Sync-Continuity-From": state.token, "X-Sync-Continuity-Next": state.pending! });
      if (result.status < 200 || result.status >= 300) {
        await this.resolve();
        let mismatch = false;
        try { mismatch = JSON.parse(new TextDecoder().decode(result.bytes)).code === "CONTINUITY_MISMATCH"; } catch { /* normal error parsing is done by Transport */ }
        if (mismatch && attempt === 0) continue;
        return result;
      }
      if (result.headers["x-sync-continuity-token"] !== state.pending) throw new Error("CONTINUITY_RESPONSE_MISMATCH");
      this.fault("after-continuity-response");
      await this.db.transaction("rw", [this.db.leases, this.db.continuity], async () => {
        await this.assertLease(); const local = await this.db.continuity.get("continuity");
        if (local?.token !== state.token || local.pending !== state.pending) throw new Error("CONTINUITY_STATE_CHANGED");
        local.token = state.pending!; delete local.pending; await this.db.continuity.put(local);
        this.fault("before-continuity-confirm-commit");
      });
      this.fault("after-continuity-confirm-commit");
      return result;
    }
    throw new RemoteError("CONTINUITY_MISMATCH");
  }
}
