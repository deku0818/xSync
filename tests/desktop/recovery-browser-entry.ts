// Isolated headless test application: real Dexie/IndexedDB, production engine, public synthetic key.
import { SyncEngine, type FilePort } from "../../plugin/src/sync/engine";
import { SyncDB } from "../../plugin/src/sync/store";
import { Transport } from "../../plugin/src/sync/transport";
import { fingerprint } from "../../plugin/src/sync/crypto";

async function file(operation: string, args: unknown[]): Promise<unknown> {
  const r = await fetch("/file", { method: "POST", body: JSON.stringify({ operation, args }) });
  if (!r.ok) throw new Error(await r.text()); return r.json();
}
const port: FilePort = {
  list: async () => await file("list", []) as string[],
  read: async path => { const b = await file("read", [path]) as number[] | null; return b === null ? null : new Uint8Array(b); },
  write: async (path, desired, expected) => { await file("write", [path, [...desired], expected === null ? null : [...expected]]); },
  rename: async (from, to, expected) => { await file("rename", [from, to, [...expected]]); },
  remove: async (path, expected) => { await file("remove", [path, [...expected]]); },
  stageWrite: async (id, bytes) => { await file("stageWrite", [id, [...bytes]]); },
  stageRead: async id => new Uint8Array(await file("stageRead", [id]) as number[]),
};
let engine: SyncEngine, db: SyncDB;
const actualNow = Date.now.bind(Date);
const api = {
  async setup(offset: number) {
    // Only the test clock advances, after the previous owning process is known dead.
    Date.now = () => actualNow() + offset;
    const cfg = await (await fetch("/config")).json() as { vaultId: string; deviceId: string; passphrase: string };
    db = new SyncDB("native-recovery"); await db.open();
    const remote = new Transport(location.origin, "synthetic-bridge", async request => {
      const r = await fetch(`/remote${new URL(request.url).pathname}${new URL(request.url).search}`, { method: request.method, body: request.body?.slice().buffer, headers: request.headers });
      return { status: r.status, headers: Object.fromEntries(r.headers.entries()), bytes: new Uint8Array(await r.arrayBuffer()) };
    });
    engine = new SyncEngine(db, remote, port, cfg.deviceId, cfg.vaultId); await engine.unlock(cfg.passphrase);
  },
  async sync() { return engine.sync(); },
  arm(point: string) { engine.fault = current => { if (current === point) { debugger; throw new Error("TEST_PROCESS_SHOULD_HAVE_BEEN_KILLED"); } }; },
  async summary(path: string) {
    const bytes = await port.read(path);
    return { status: await engine.status(), progress: await db.progress.get("progress"), outbox: await db.outbox.count(), tasks: await db.applyTasks.count(), local: await db.localFiles.toArray(), hash: bytes === null ? null : await fingerprint(bytes) };
  },
};
(globalThis as typeof globalThis & { recovery: typeof api }).recovery = api;
