import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { RecoveryFixture } from "./recovery-support";

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("accepted baselines and durable request acknowledgements", () => {
  let fixture: RecoveryFixture;
  beforeEach(async () => { fixture = new RecoveryFixture(); await fixture.open(); await fixture.client(0); await fixture.client(1); }, 20000);
  afterEach(async () => { await fixture?.close(); });

  it("retries an acknowledgement lost after server commit without repeating the original operation", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "exact accepted bytes"); let lose = true;
    fixture.httpHook = async (request, next) => {
      const response = await next();
      if (lose && request.url.endsWith("/metadata/ack") && response.status === 200) { lose = false; throw new Error("LOST_ACK"); }
      return response;
    };
    expect((await a.engine.sync()).errors).toContain("LOST_ACK");
    expect(await a.db.outbox.count()).toBe(0); expect(await a.db.requestAcks.count()).toBe(1);
    fixture.httpHook = undefined; const reopened = await fixture.reopen(0);
    expect((await reopened.engine.sync()).errors).toEqual([]); expect(await reopened.db.requestAcks.count()).toBe(0);
    expect((await fixture.transport(0).handshake()).seq).toBe(1);
    expect(await reopened.db.baseProofs.count()).toBe(1);
  });

  it("does not skip an excluded or failed sequence when later files have been confirmed", async () => {
    const a = fixture.clients[0]!; await a.files.edit("blocked.md", "base"); await a.engine.sync();
    const local = (await a.db.localFiles.toArray())[0]!, proof = (await a.db.baseProofs.get(local.revision))!;
    await a.db.baseProofs.put({ ...proof, proof: { ...proof.proof, token: "0".repeat(64) } });
    await a.files.edit("blocked.md", "pending bytes"); await a.files.edit("healthy.md", "unrelated accepted bytes");
    expect((await a.engine.sync()).errors).toContain("BASE_PROOF_INVALID");
    const row = (await a.db.outbox.toArray())[0]!; expect(row.error).toBe("BASE_PROOF_INVALID");
    const stream = await fixture.transport(0).requestStream(); expect(stream.maximum).toBe(3); expect(stream.retired).toBe(1);
    expect(await a.files.text("blocked.md")).toBe("pending bytes");
    await a.db.baseProofs.delete(local.revision); expect((await a.engine.sync()).errors).toEqual([]);
    expect((await fixture.transport(0).requestStream()).retired).toBe(3);
    await fixture.clients[1]!.engine.sync(); expect(await fixture.clients[1]!.files.text("blocked.md")).toBe("pending bytes");
  });

  it("blocks a restored request counter before it can assign a new operation to an old identity", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "one"); await a.engine.sync();
    const checkpoint = (await a.db.writerState.get("writer"))!;
    await a.files.edit("note.md", "two"); await a.engine.sync();
    await a.db.writerState.put(checkpoint); await a.files.edit("note.md", "fresh bytes after old backup");
    expect((await a.engine.sync()).errors).toContain("REQUEST_STREAM_RECONCILIATION_REQUIRED");
    expect(await a.files.text("note.md")).toBe("fresh bytes after old backup");
    expect((await fixture.transport(0).handshake()).seq).toBe(2); expect(await a.db.outbox.count()).toBe(0);
  });

  it("stores the actually displayed peer baseline before a later offline edit", async () => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "shown base"); await a.engine.sync(); await b.engine.sync();
    const original = (await b.db.localFiles.toArray())[0]!, accepted = (await b.db.baseProofs.get(original.revision))!;
    expect(accepted.proof.fileId).toBe(original.id); expect(accepted.proof.revisionId).toBe(original.revision);
    await b.files.edit("note.md", "offline B"); await a.files.edit("note.md", "concurrent A"); await a.engine.sync();
    expect((await b.engine.sync()).conflicts).toBe(1);
    const review = await b.engine.review(original.id); expect(review.versions.map(v => v.text).sort()).toEqual(["concurrent A", "offline B"]);
  });

  it("assigns tracking outside a pre-upgrade immutable outbox body", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "legacy captured bytes");
    fixture.httpHook = async (request, next) => { if (request.method === "PUT") throw new Error("OFFLINE"); return next(); };
    await a.engine.sync(); fixture.httpHook = undefined;
    const row = (await a.db.outbox.toArray())[0]!; delete row.coordinate;
    row.request.requiredFeatures = row.request.requiredFeatures.filter(value => value !== "metadata-anchors-v1");
    await a.db.outbox.put(row); await a.db.writerState.clear(); const original = structuredClone(row.request);
    const sent: unknown[] = [];
    fixture.httpHook = async (request, next) => { if (request.url.endsWith("/metadata/commits")) sent.push(JSON.parse(new TextDecoder().decode(request.body)).request); return next(); };
    expect((await a.engine.sync()).errors).toEqual([]); expect(sent).toContainEqual(original);
    expect((await fixture.transport(0).handshake()).seq).toBe(1);
  });
  it.each(["epoch", "digest", "file"])("rejects a mismatched %s certificate before applying peer content", async kind => {
    const a = fixture.clients[0]!, b = fixture.clients[1]!; await a.files.edit("note.md", "authenticated peer content"); await a.engine.sync();
    fixture.httpHook = async (request, next) => {
      const response = await next();
      if (request.url.endsWith("/metadata/base") && response.status === 200) {
        const anchor = JSON.parse(new TextDecoder().decode(response.bytes));
        if (kind === "epoch") anchor.proof.epoch = "other-epoch";
        if (kind === "digest") anchor.proof.digest = "0".repeat(64);
        if (kind === "file") anchor.proof.fileId = "other-file";
        response.bytes = new TextEncoder().encode(JSON.stringify(anchor));
      }
      if (/\/snapshots\/[a-f0-9]+(?:\/pages)?$/.test(new URL(request.url).pathname) && response.status === 200) {
        const snapshot = JSON.parse(new TextDecoder().decode(response.bytes)), proof = snapshot.bases?.[0];
        if (proof) {
          if (kind === "epoch") proof.epoch = "other-epoch";
          if (kind === "digest") proof.digest = "0".repeat(64);
          if (kind === "file") proof.fileId = "other-file";
          response.bytes = new TextEncoder().encode(JSON.stringify(snapshot));
        }
      }
      return response;
    };
    expect((await b.engine.sync()).errors).toContain("BASE_ANCHOR_MISMATCH");
    expect(await b.files.text("note.md")).toBeNull(); expect(await b.db.baseProofs.count()).toBe(0);
    fixture.httpHook = undefined; expect((await b.engine.sync()).errors).toEqual([]);
    expect(await b.files.text("note.md")).toBe("authenticated peer content");
  });
});
