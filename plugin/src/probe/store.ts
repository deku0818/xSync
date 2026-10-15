import Dexie, { type Table } from "dexie";

export interface ProbeMarker {
  id: string;
  session: string;
  created: string;
  token: string;
}
export class ProbeStore extends Dexie {
  markers!: Table<ProbeMarker, string>;
  inbox!: Table<{ seq: number; task: string }, number>;
  cursors!: Table<{ id: string; received: number }, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ markers: "id", inbox: "seq", cursors: "id" });
  }
  /** One local transaction: failing between task and cursor must roll back both. */
  async receiveFixture(seq: number, abort = false): Promise<void> {
    await this.transaction("rw", this.inbox, this.cursors, async () => {
      await this.inbox.put({ seq, task: "synthetic-apply-task" });
      if (abort) throw new Error("injected-before-cursor");
      await this.cursors.put({ id: "receive", received: seq });
    });
  }
  async verifyTransactions(): Promise<Record<string, boolean>> {
    await this.transaction("rw", this.inbox, this.cursors, async () => {
      await this.inbox.clear(); await this.cursors.clear();
    });
    try { await this.receiveFixture(1, true); } catch (error) {
      if (!(error instanceof Error) || error.message !== "injected-before-cursor") throw error;
    }
    const rollback = await this.inbox.count() === 0 && await this.cursors.count() === 0;
    if (!rollback) throw new Error("IndexedDB transaction did not roll back");
    await this.receiveFixture(1);
    const committed = !!await this.inbox.get(1) && (await this.cursors.get("receive"))?.received === 1;
    if (!committed) throw new Error("IndexedDB transaction did not commit");
    return { rollback, committed };
  }
}
