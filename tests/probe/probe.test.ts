import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { ProbeStore } from "../../plugin/src/probe/store";
import { fixture, verifyFixture } from "../../plugin/src/probe/fixtures";
import { cryptoProbe } from "../../plugin/src/probe/crypto";

it("rolls task/cursor back together and retains marker through connection reopen (fake IndexedDB only)", async () => {
  const name = "probe-unit-test";
  let db = new ProbeStore(name);
  try {
    await db.open();
    expect(await db.verifyTransactions()).toEqual({ rollback: true, committed: true });
    await db.markers.put({ id: "first", session: "before-reopen", created: "fixture", token: "public-test-token" });
    db.close(); db = new ProbeStore(name); await db.open();
    expect((await db.markers.get("first"))?.session).toBe("before-reopen");
    expect((await db.cursors.get("receive"))?.received).toBe(1);
  } finally { await db.delete(); }
});

it("detects truncation and corruption of the synthetic large-file fixture", () => {
  const bytes = fixture(1); verifyFixture(bytes, 1);
  expect(() => verifyFixture(bytes.slice(0, -1), 1)).toThrow("length mismatch");
  new Uint8Array(bytes)[4500] = 0;
  expect(() => verifyFixture(bytes, 1)).toThrow("Fixture mismatch");
  expect(() => fixture(999)).toThrow("Unsupported fixture size");
});

it("executes candidate Argon2id and rejects wrong keys, corrupted cipher and altered AAD (Node only)", async () => {
  expect(await cryptoProbe()).toMatchObject({ roundtrip: true, wrongKeyRejected: true, corruptRejected: true, aadRejected: true, memoryBytes: 67108864 });
}, 20_000);
