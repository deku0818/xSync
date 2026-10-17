import { afterEach, expect, it, vi } from "vitest";
import { Transport, type HTTPRequest } from "../../plugin/src/sync/transport";
import { fingerprint } from "../../plugin/src/sync/crypto";
import type { Commit } from "../../protocol/src/types";

const encoder = new TextEncoder();
const json = (body: unknown) => ({ status: 200, headers: {}, bytes: encoder.encode(JSON.stringify(body)) });
const id = "a".repeat(64);
const request: Commit = { protocol: 0, vaultId: "vault", epoch: "epoch", deviceId: "device", opId: "op", requiredFeatures: ["causal-heads"], actions: [
  { type: "create", fileId: "file", revisionId: "revision", location: { revision: "location", pathKey: id, encryptedPath: "ciphertext" }, payload: { kind: "file", keyEpoch: 1, encryptedManifest: "ciphertext", objects: [id] } },
] };
afterEach(() => { vi.restoreAllMocks(); });

it("negotiates content protection in headers while preserving an immutable legacy commit body", async () => {
  const calls: HTTPRequest[] = [];
  const transport = new Transport("http://127.0.0.1:8873", "synthetic-token", async call => {
    calls.push(call);
    return call.url.endsWith("/commits") ? json({ epoch: "epoch", seq: 1, opId: "op" }) : json({ id });
  });
  expect(await transport.uploadLease(request)).toBe(id); await transport.commit(request);
  expect(calls.map(call => JSON.parse(new TextDecoder().decode(call.body)))).toEqual([request, request]);
  expect(calls.every(call => call.headers["X-Sync-Content"] === "content-leases-v1")).toBe(true);
  expect(request.requiredFeatures).toEqual(["causal-heads"]);
});

it("reuses snapshot creation identity after a lost response and releases the known snapshot", async () => {
  const creations: unknown[] = [], released: string[] = []; let lose = true;
  const transport = new Transport("http://127.0.0.1:8873", "synthetic-token", async call => {
    if (call.method === "DELETE") { released.push(call.url); return json({ released: true }); }
    if (call.method === "POST") {
      creations.push(JSON.parse(new TextDecoder().decode(call.body)));
      if (lose) { lose = false; throw new Error("LOST_RESPONSE"); }
      return json({ id: id.slice(0, 32), leaseId: id });
    }
    return json({ epoch: "epoch", boundary: 0, files: [], revisions: [] });
  });
  await expect(transport.snapshot()).rejects.toThrow("LOST_RESPONSE");
  expect(await transport.snapshot()).toMatchObject({ boundary: 0 });
  expect(creations[1]).toEqual(creations[0]); await transport.releaseSnapshots();
  expect(released).toEqual([`http://127.0.0.1:8873/content/leases/${id}`]);
});

it("renews active transfers before more chunks and keeps protection attached to each object read", async () => {
  let clock = 100000; vi.spyOn(Date, "now").mockImplementation(() => clock);
  const bytes = encoder.encode("authenticated ciphertext"), digest = await fingerprint(bytes);
  const calls: HTTPRequest[] = [];
  const transport = new Transport("http://127.0.0.1:8873", "synthetic-token", async call => {
    calls.push(call);
    if (call.url.endsWith("/renew")) return json({ renewed: true });
    if (call.url.endsWith("/content/read")) return json({ id });
    return { status: 200, headers: { "x-ciphertext-sha256": digest }, bytes };
  });
  const lease = await transport.readLease("revision"); clock += 61000;
  expect(await transport.object(id, lease)).toEqual(bytes);
  expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/content/read", `/content/leases/${id}/renew`, `/objects/${id}`]);
  expect(calls[2]!.headers["X-Content-Lease"]).toBe(id);
});

it("does not reinterpret ciphertext corruption as a normal expired view", async () => {
  const transport = new Transport("http://127.0.0.1:8873", "synthetic-token", async call => call.url.endsWith("/content/read") ? json({ id }) : ({ status: 200, headers: { "x-ciphertext-sha256": id }, bytes: encoder.encode("corrupt") }));
  const lease = await transport.readLease("revision");
  await expect(transport.object(id, lease)).rejects.toThrow("OBJECT_DIGEST_MISMATCH");
});

it("rejects a self-consistent response digest when ciphertext does not match its addressed ID", async () => {
  const bytes = encoder.encode("different addressed ciphertext"), digest = await fingerprint(bytes);
  const transport = new Transport("http://127.0.0.1:8873", "synthetic-token", async call => call.url.endsWith("/content/read") ? json({ id }) : ({ status: 200, headers: { "x-ciphertext-sha256": digest }, bytes }));
  const lease = await transport.readLease("revision");
  await expect(transport.object(`c_${id}`, lease)).rejects.toThrow("OBJECT_DIGEST_MISMATCH");
});
