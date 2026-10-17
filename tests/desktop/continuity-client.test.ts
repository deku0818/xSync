import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SyncDB } from "../../plugin/src/sync/store";
import { ContinuityClient } from "../../plugin/src/sync/continuity-client";
import { Transport, type HTTPResponse } from "../../plugin/src/sync/transport";
import { randomId } from "../../plugin/src/sync/crypto";

let db: SyncDB, remote: Transport, server: string, calls: number, failure: "" | "rollback" | "committed" | "delayed";
let delayed: Record<string, string> | undefined;
const json = (body: unknown, status = 200, token?: string): HTTPResponse => ({ status, headers: token ? { "x-sync-continuity-token": token } : {}, bytes: new TextEncoder().encode(JSON.stringify(body)) });
const assertLease = async () => { if ((await db.leases.get("engine"))?.owner !== "test") throw new Error("LOCAL_LEASE_LOST"); };
beforeEach(async () => {
  db = new SyncDB(`continuity-${randomId()}`); await db.open(); await db.leases.put({ id: "engine", owner: "test", until: Date.now() + 60000 });
  server = randomId(); calls = 0; failure = ""; delayed = undefined;
  remote = new Transport("http://127.0.0.1:8873", "fixture", async request => {
    if (request.url.endsWith("/metadata/continuity")) return json({ token: server });
    if (request.url.endsWith("/metadata/continuity/fence")) {
      if (request.headers["X-Sync-Continuity-From"] !== server) return json({ code: "CONTINUITY_MISMATCH" }, 409);
      server = request.headers["X-Sync-Continuity-Next"]!;
      return json({ token: server }, 200, server);
    }
    calls++;
    if (failure === "delayed") { delayed = request.headers; throw new Error("NETWORK_TIMEOUT"); }
    if (request.headers["X-Sync-Continuity-From"] !== server) return json({ code: "CONTINUITY_MISMATCH" }, 409);
    if (failure === "rollback") return json({ code: "NEED_SNAPSHOT" }, 409);
    server = request.headers["X-Sync-Continuity-Next"]!;
    if (failure === "committed") throw new Error("LOST_RESPONSE");
    return json([], 200, server);
  });
});
afterEach(async () => { await db.delete(); });

it.each(["after-continuity-intent-commit", "after-continuity-response", "before-continuity-confirm-commit", "after-continuity-confirm-commit"])("recovers a durable continuity boundary at %s before returning data", async point => {
  let hit = false;
  const client = new ContinuityClient(db, remote, assertLease, current => { if (!hit && current === point) { hit = true; throw new Error("INTERRUPTED"); } });
  await client.initialize(); await expect(remote.changes("E", 0)).rejects.toThrow("INTERRUPTED"); expect(hit).toBe(true);
  const name = db.name; db.close(); db = new SyncDB(name); await db.open();
  await new ContinuityClient(db, remote, assertLease, () => {}).initialize();
  expect(await remote.changes("E", 0)).toEqual([]); expect((await db.continuity.get("continuity"))!.token).toBe(server);
  expect((await db.continuity.get("continuity"))!.pending).toBeUndefined();
});
it("blocks a different restored token even when global sequence numbers could have caught up", async () => {
  await new ContinuityClient(db, remote, assertLease, () => {}).initialize();
  const backup = server; await remote.changes("E", 0); const local = (await db.continuity.get("continuity"))!;
  server = backup;
  await expect(new ContinuityClient(db, remote, assertLease, () => {}).initialize()).rejects.toThrow("RECOVERY_RECONCILIATION_REQUIRED");
  expect(await db.continuity.get("continuity")).toEqual(local); expect(calls).toBe(1);
});
it("resolves a committed request with a lost response without resetting the confirmed token", async () => {
  await new ContinuityClient(db, remote, assertLease, () => {}).initialize(); failure = "committed";
  await expect(remote.changes("E", 0)).rejects.toThrow("LOST_RESPONSE");
  expect((await db.continuity.get("continuity"))!.pending).toBe(server);
  failure = ""; await new ContinuityClient(db, remote, assertLease, () => {}).initialize();
  expect((await db.continuity.get("continuity"))!.token).toBe(server); expect(await remote.changes("E", 0)).toEqual([]);
});
it("fences a rolled-back operation without accepting its response as data", async () => {
  await new ContinuityClient(db, remote, assertLease, () => {}).initialize(); const before = server; failure = "rollback";
  await expect(remote.changes("E", 0)).rejects.toThrow("NEED_SNAPSHOT");
  expect(server).not.toBe(before); expect((await db.continuity.get("continuity"))!).toMatchObject({ token: server }); expect((await db.continuity.get("continuity"))!.pending).toBeUndefined();
  failure = ""; expect(await remote.changes("E", 0)).toEqual([]);
});
it("fences a timed-out request before forgetting its pending token so a late arrival cannot overwrite the register", async () => {
  await new ContinuityClient(db, remote, assertLease, () => {}).initialize(); failure = "delayed";
  await expect(remote.changes("E", 0)).rejects.toThrow("NETWORK_TIMEOUT");
  const pending = (await db.continuity.get("continuity"))!.pending;
  expect(server).toBe(delayed!["X-Sync-Continuity-From"]);
  failure = ""; await new ContinuityClient(db, remote, assertLease, () => {}).initialize();
  expect(server).toBe(pending);
  // The original request now reaches its transaction: its original CAS must fail.
  expect(delayed!["X-Sync-Continuity-From"]).not.toBe(server);
  expect(await remote.changes("E", 0)).toEqual([]);
  await new ContinuityClient(db, remote, assertLease, () => {}).initialize();
  expect((await db.continuity.get("continuity"))!.token).toBe(server);
});
