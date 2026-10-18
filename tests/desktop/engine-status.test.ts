import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { SYNC_FEATURES } from "../../protocol/src/wire";
import type { Commit } from "../../protocol/src/types";
import { SyncEngine, type EngineStatus, type FilePort } from "../../plugin/src/sync/engine";
import { revisionDigest } from "../../plugin/src/sync/metadata-client";
import { SyncDB } from "../../plugin/src/sync/store";
import { VaultCrypto, randomId } from "../../plugin/src/sync/crypto";
import { RemoteError, type Transport } from "../../plugin/src/sync/transport";

it("reports activity and live outbox counts during upload, then retains failures until a successful retry", async () => {
  const vaultId = randomId(), epoch = randomId(), deviceId = randomId();
  const created = await VaultCrypto.create(vaultId, "public-status-test"); created.crypto.close();
  const db = new SyncDB(`status-${randomId()}`);
  const staged = new Map<string, Uint8Array>(), uploaded = new Set<string>();
  let paths = ["a.md", "b.md"];
  const files: FilePort = {
    list: async () => paths, read: async path => new TextEncoder().encode(path),
    write: async () => {}, rename: async () => {}, remove: async () => {},
    stageWrite: async (id, bytes) => { staged.set(id, bytes); }, stageRead: async id => staged.get(id)!,
    stageList: async () => [...staged.keys()], stageRemove: async id => { staged.delete(id); },
  };
  let probe = false, fail = false, serverSeq = 0;
  let engine: SyncEngine;
  const checking: EngineStatus[] = [], uploading: EngineStatus[] = [];
  const remote = {
    handshake: async () => {
      if (probe) checking.push(await engine.status());
      return { vaultId, epoch, seq: serverSeq, features: [...SYNC_FEATURES], keyPackage: created.keyPackage, devices: [{ id: deviceId, name: "Status test" }] };
    },
    snapshotPages: async () => ({ epoch, boundary: 0 }), changes: async () => [],
    requestStream: async () => ({ id: "c".repeat(64), maximum: serverSeq, retired: 0 }),
    acknowledgeRequest: async () => {},
    commitTracked: async (request: Commit) => {
      if (request.actions.some(a => "payload" in a && a.payload.objects.some(id => !uploaded.has(id)))) throw new RemoteError("OBJECT_MISSING");
      const bases = [];
      for (const a of request.actions) if (a.type === "create") {
        const revision = { id: a.revisionId, fileId: a.fileId, parents: [], deviceId, payload: a.payload };
        bases.push({ revision, proof: { vaultId, epoch, fileId: a.fileId, revisionId: a.revisionId, digest: await revisionDigest(revision), boundary: serverSeq + 1, token: "d".repeat(64) } });
      }
      return { receipt: { opId: request.opId, epoch, seq: ++serverSeq }, bases };
    },
    uploadLease: async () => "synthetic-lease", releaseContent: async () => {}, releaseSnapshots: async () => {},
    upload: async (id: string) => {
      uploading.push(await engine.status());
      if (fail) throw new Error("INJECTED_OFFLINE_UPLOAD");
      uploaded.add(id);
    },
  } as unknown as Transport;
  engine = new SyncEngine(db, remote, files, deviceId, vaultId);
  try {
    await engine.unlock("public-status-test"); probe = true;
    fail = true; const failed = await engine.sync();
    expect(checking[0]).toMatchObject({ state: "pending", activity: "checking", outbox: 0 });
    expect(uploading[0]).toMatchObject({ state: "pending", activity: "uploading", outbox: 2 });
    expect(uploading[0]!.progress).toMatchObject({ phase: "uploading", completed: 0, total: 2, path: "a.md", bytesDone: 0, bytesTotal: 4 });
    expect(failed).toMatchObject({ state: "needs-attention", outbox: 2, errors: ["INJECTED_OFFLINE_UPLOAD"] });
    expect(failed.activity).toBeUndefined();
    fail = false; uploading.length = 0;
    expect(await engine.sync()).toMatchObject({ state: "complete", outbox: 0, errors: [] });
    expect(uploading.map(s => s.outbox)).toEqual([2, 1]);
    expect(uploading.map(s => s.progress!.completed)).toEqual([0, 1]);
    expect(uploading.every(s => s.activity === "uploading" && s.state === "pending")).toBe(true);
    expect((await engine.status()).activity).toBeUndefined();
    paths = ["a.md", "b.md", "bad?.md"];
    await db.markDirty("bad?.md");
    expect(await engine.sync()).toMatchObject({ state: "needs-attention", issues: [{ path: "bad?.md", code: "UNSUPPORTED_PATH", phase: "checking" }] });
    const material = engine.rememberedMaterial(); engine.lock();
    engine = new SyncEngine(db, remote, files, deviceId, vaultId); await engine.restoreRemembered(material);
    expect(await engine.status()).toMatchObject({ state: "needs-attention", errors: ["UNSUPPORTED_PATH"], issues: [{ path: "bad?.md", code: "UNSUPPORTED_PATH" }] });
    paths = ["a.md", "b.md", "renamed.md"];
    expect(await engine.sync()).toMatchObject({ state: "complete", issues: [], errors: [] });
    expect(await db.dirtyFiles.count()).toBe(0);
    await db.issues.put({ path: "unvisited.md", phase: "applying", code: "TEMPORARY_READ_FAILURE" });
    expect(await engine.sync({ full: false })).toMatchObject({ state: "needs-attention", issues: [{ path: "unvisited.md", code: "TEMPORARY_READ_FAILURE" }] });
  } finally { engine.lock(); await db.delete(); }
});
