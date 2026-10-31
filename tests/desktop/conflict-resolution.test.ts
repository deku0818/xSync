import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { VaultModel } from "../../protocol/src/model";
import type { Commit, Revision } from "../../protocol/src/types";
import { SYNC_FEATURES } from "../../protocol/src/wire";
import { VaultCrypto, bytesEqual, fingerprint, randomId } from "../../plugin/src/sync/crypto";
import { SyncEngine, type FilePort } from "../../plugin/src/sync/engine";
import { revisionDigest } from "../../plugin/src/sync/metadata-client";
import { SyncDB } from "../../plugin/src/sync/store";
import type { Transport } from "../../plugin/src/sync/transport";

// Real encryption, persistence and engine; the protocol model replaces HTTP/PostgreSQL.
it.each(["mac", "phone"])("commits the selected %s version and clears the conflict", async selectedDevice => {
  const vaultId = randomId(), epoch = randomId(), fileId = randomId(), deviceId = "mac";
  const created = await VaultCrypto.create(vaultId, "public-resolution-test");
  const db = new SyncDB(`resolution-${randomId()}`), model = new VaultModel(vaultId, epoch);
  const objects = new Map<string, Uint8Array>(), stages = new Map<string, Uint8Array>();
  const contents = { base: "base content", mac: "Mac chosen content", phone: "iPhone different content" };
  const encoder = new TextEncoder(), path = "note.md", location = created.crypto.location(fileId, path);
  const request = (actions: Commit["actions"], device = deviceId): Commit => ({ protocol: 0, vaultId, epoch, deviceId: device, opId: randomId(), requiredFeatures: [], actions });
  for (const device of ["base", "mac", "phone"] as const) {
    const bytes = encoder.encode(contents[device]), object = created.crypto.object(bytes);
    objects.set(object.id, object.bytes); model.declareDurableObject(object.id);
    const revision = { id: device, fileId, parents: device === "base" ? [] : ["base"], deviceId: device };
    const payload = await created.crypto.payload(revision, bytes, "file", [object.id]);
    model.commit(request([device === "base" ? { type: "create", fileId, revisionId: device, location, payload } : { type: "edit", fileId, revisionId: device, displayedRevision: "base", payload }], device));
  }
  let disk = encoder.encode(contents.mac), maximum = 0;
  const files: FilePort = {
    list: async () => [path], read: async name => name === path ? disk.slice() : null,
    write: async (_name, desired, expected) => { expect(expected && bytesEqual(disk, expected)).toBe(true); disk = desired.slice(); },
    rename: async () => { throw new Error("UNEXPECTED_RENAME"); }, remove: async () => { throw new Error("UNEXPECTED_DELETE"); },
    stageWrite: async (id, bytes) => { stages.set(id, bytes); }, stageRead: async id => stages.get(id)!,
    stageList: async () => [...stages.keys()], stageRemove: async id => { stages.delete(id); },
  };
  const anchor = async (revision: Revision) => ({ revision, proof: { vaultId, epoch, fileId: revision.fileId, revisionId: revision.id, digest: await revisionDigest(revision), boundary: model.snapshot().boundary, token: "d".repeat(64) } });
  const remote = {
    handshake: async () => ({ vaultId, epoch, seq: model.snapshot().boundary, features: [...SYNC_FEATURES], keyPackage: created.keyPackage, devices: [{ id: "mac", name: "Mac" }, { id: "phone", name: "iPhone" }] }),
    requestStream: async () => ({ id: "c".repeat(64), maximum, retired: 0 }), acknowledgeRequest: async () => {},
    changes: async (requestedEpoch: string, after: number) => model.pull(requestedEpoch, after),
    certifyBase: async (revision: Revision) => anchor(revision),
    commitTracked: async (commit: Commit, coordinate: { number: number }) => {
      const receipt = model.commit({ ...commit, requiredFeatures: [] }); maximum = coordinate.number;
      const ids = new Set(commit.actions.flatMap(action => "revisionId" in action ? [action.revisionId] : []));
      return { receipt, bases: await Promise.all(model.snapshot().revisions.filter(revision => ids.has(revision.id)).map(anchor)) };
    },
    readLease: async () => "synthetic-lease", uploadLease: async () => "synthetic-lease",
    object: async (id: string) => objects.get(id)!, releaseContent: async () => {}, releaseSnapshots: async () => {},
  } as unknown as Transport;
  const engine = new SyncEngine(db, remote, files, deviceId, vaultId);
  try {
    const snapshot = model.snapshot();
    await db.progress.put({ id: "progress", vaultId, epoch, received: snapshot.boundary, applied: 0 });
    await db.remoteFiles.bulkPut(snapshot.files); await db.revisions.bulkPut(snapshot.revisions);
    await db.localFiles.put({ id: fileId, path, location, revision: "mac", fingerprint: await fingerprint(disk), deleted: false });
    await db.conflicts.put({ id: fileId, path, heads: ["mac", "phone"], reason: "CONCURRENT_REVISIONS" });
    await engine.unlock("public-resolution-test");
    const review = await engine.review(fileId);
    await engine.resolve(review, selectedDevice);
    expect(new TextDecoder().decode(disk)).toBe(contents[selectedDevice as "mac" | "phone"]);
    expect((await engine.status()).conflicts).toBe(0); expect(await db.outbox.count()).toBe(0);
    expect(model.snapshot().files[0]!.heads).toHaveLength(1);
    expect(await engine.sync()).toMatchObject({ state: "complete", errors: [] });
  } finally { engine.lock(); created.crypto.close(); await db.delete(); }
});
