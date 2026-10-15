import { canonical } from "./model";
import { ProtocolError, type Change } from "./types";

/** Transaction-sized receive/apply semantics. Persistence and Vault I/O are not implemented here. */
export class InboxModel {
  received = 0;
  applied = 0;
  private tasks = new Map<number, { change: Change; done: boolean }>();
  constructor(readonly epoch: string, boundary = 0) {
    if (!Number.isSafeInteger(boundary) || boundary < 0) throw new ProtocolError("INVALID_REQUEST");
    this.received = boundary; this.applied = boundary;
  }
  receive(epoch: string, changes: Change[]): void {
    if (epoch !== this.epoch) throw new ProtocolError("EPOCH_CHANGED");
    const staged = structuredClone(this.tasks);
    let next = this.received;
    for (const change of changes) {
      const existing = staged.get(change.seq);
      if (existing) {
        if (canonical(existing.change) !== canonical(change)) throw new ProtocolError("INVALID_REQUEST");
        continue;
      }
      if (change.seq !== next + 1) throw new ProtocolError("INVALID_REQUEST");
      staged.set(change.seq, { change: structuredClone(change), done: false }); next = change.seq;
    }
    // A future IndexedDB implementation must persist both in ONE short transaction.
    this.tasks = staged; this.received = next;
  }
  complete(seq: number): void {
    const task = this.tasks.get(seq);
    if (!task) throw new ProtocolError("INVALID_REQUEST");
    task.done = true;
    while (this.tasks.get(this.applied + 1)?.done) this.applied++;
  }
  pending(): Change[] { return [...this.tasks.values()].filter(t => !t.done).map(t => structuredClone(t.change)); }
  status(conflicts: number, outbox: number, failures: number): "needs-attention" | "pending" | "complete" {
    if (conflicts || failures) return "needs-attention";
    return outbox || this.received !== this.applied ? "pending" : "complete";
  }
}

/** An uploaded snapshot does not acknowledge subsequent local bytes. */
export function acknowledgesCurrent(snapshotFingerprint: string, currentFingerprint: string): boolean {
  return snapshotFingerprint === currentFingerprint;
}
