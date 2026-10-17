import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { VaultModel, editFromDisplayed } from "../../protocol/src/model";
import type { Action, Commit, Create, Payload, Resolve } from "../../protocol/src/types";

const payload = (kind: Payload["kind"] = "file", objects = ["blob"]): Payload => ({
  kind, objects: kind === "file" ? objects : [], keyEpoch: 1, encryptedManifest: "synthetic-ciphertext",
});
const create = (fileId = "F", revisionId = "A", pathKey = "opaque-path"): Create => ({
  type: "create", fileId, revisionId, payload: payload(),
  location: { revision: `L-${fileId}`, pathKey, encryptedPath: "synthetic-encrypted-path" },
});
const request = (opId: string, actions: Action[], deviceId = "computer"): Commit => ({
  protocol: 0, vaultId: "V", epoch: "E", requiredFeatures: ["causal-heads"], deviceId, opId, actions,
});
function setup() {
  const model = new VaultModel("V", "E"); model.declareDurableObject("blob");
  model.commit(request("create", [create()])); return model;
}
const edit = (id: string, parent = "A", kind: Payload["kind"] = "file") => editFromDisplayed("F", id, parent, payload(kind));
const heads = (m: VaultModel) => m.snapshot().files.find(f => f.id === "F")!.heads;
const resolve = (observedHeads = ["B", "C"]): Resolve => ({
  type: "resolve", fileId: "F", observedHeads, revisionId: "R", payload: payload(),
  decision: { kind: "select", selectedRevision: "B" },
});

describe("causal revisions and explicit decisions", () => {
  it("retains concurrent edits in either arrival order, with exact displayed parents", () => {
    for (const order of [["B", "C"], ["C", "B"]]) {
      const m = setup();
      order.forEach(x => m.commit(request(x, [edit(x)], x)));
      expect(heads(m)).toEqual(["B", "C"]);
      expect(m.snapshot().revisions.filter(r => r.id !== "A").map(r => r.parents)).toEqual([["A"], ["A"]]);
    }
  });
  it("preserves deletion versus edit, and unrelated files can progress", () => {
    const m = setup(); m.commit(request("delete", [edit("D", "A", "deleted")]));
    m.commit(request("phone", [edit("C")], "iphone"));
    expect(heads(m)).toEqual(["C", "D"]);
    m.commit(request("other", [create("G", "G1", "other-path")]));
    expect(m.snapshot().files).toHaveLength(2);
    expect(heads(m)).toEqual(["C", "D"]);
  });
  it("separates rename and content editing", () => {
    const m = setup();
    m.commit(request("rename", [{ type: "move", fileId: "F", expectedLocation: "L-F", location: {
      revision: "L2", pathKey: "new-path", encryptedPath: "encrypted-new-path",
    } }]));
    m.commit(request("phone-edit", [edit("B")], "iphone"));
    expect(m.snapshot().files[0]).toMatchObject({ heads: ["B"], location: { revision: "L2", pathKey: "new-path" } });
  });
  it("rejects stale review after a new branch, with no mutation", () => {
    const m = setup(); for (const x of ["B", "C", "D"]) m.commit(request(x, [edit(x)], x));
    const before = m.snapshot(); expect(() => m.commit(request("resolve", [resolve()]))).toThrow("REVIEW_STALE");
    expect(m.snapshot()).toEqual(before);
  });
  it("resolves only the observed heads, retaining immutable history", () => {
    const m = setup(); for (const x of ["B", "C"]) m.commit(request(x, [edit(x)], x));
    m.commit(request("resolve", [resolve()]));
    expect(heads(m)).toEqual(["R"]);
    expect(m.snapshot().revisions.map(r => r.id)).toEqual(["A", "B", "C", "R"]);
    m.commit(request("offline-later", [edit("D")], "old-phone"));
    expect(heads(m)).toEqual(["D", "R"]);
  });
  it("keep-both creates one stable companion atomically and is retry safe", () => {
    const m = setup(); for (const x of ["B", "C"]) m.commit(request(x, [edit(x)], x));
    const a = resolve(); a.decision = { kind: "keep-both", selectedRevision: "B", companionSource: "C", companion: create("G", "G1", "copy-path") };
    const req = request("keep", [a]); const receipt = m.commit(req);
    expect(m.commit(structuredClone(req))).toEqual(receipt);
    expect(m.snapshot().files.map(f => f.heads)).toEqual([["R"], ["G1"]]);
    expect(m.snapshot().revisions.find(r => r.id === "G1")?.selectedFrom).toBe("C");
  });
  it("keeps both original branches if the companion path is occupied", () => {
    const m = setup(); for (const x of ["B", "C"]) m.commit(request(x, [edit(x)], x));
    const a = resolve(); a.decision = { kind: "keep-both", selectedRevision: "B", companionSource: "C", companion: create("G", "G1") };
    const before = m.snapshot(); expect(() => m.commit(request("bad-keep", [a]))).toThrow("PATH_OCCUPIED");
    expect(m.snapshot()).toEqual(before);
  });
  it("rejects foreign parents, invented heads and duplicate review heads", () => {
    const m = setup(); m.commit(request("other", [create("G", "G1", "other-path")]));
    expect(() => m.commit(request("bad-parent", [edit("B", "G1")]))).toThrow("PARENT_MISSING");
    m.commit(request("B", [edit("B")])); m.commit(request("C", [edit("C")]));
    expect(() => m.commit(request("bad-heads", [resolve(["B", "B"])]))).toThrow("REVIEW_STALE");
    expect(() => m.commit(request("invented", [resolve(["B", "Z"])]))).toThrow("REVIEW_STALE");
  });
  it("models zero-byte files, explicit directories and deletion as distinct states", () => {
    const m = new VaultModel("V", "E"); const a = create(); a.payload = payload("file", []);
    const dir = create("dir", "dir1", "dir-path"); dir.payload = payload("directory");
    m.commit(request("create", [a, dir]));
    expect(m.snapshot().files.map(f => f.entryKind)).toEqual(["file", "directory"]);
    m.commit(request("delete", [edit("D", "A", "deleted")]));
    expect(m.snapshot().revisions.find(r => r.id === "A")?.payload.kind).toBe("file");
  });
});

describe("commit boundaries and recovery gates", () => {
  it("binds the actual request to device/op ID, returns original receipt after later commits", () => {
    const m = setup(); const r = request("edit", [edit("B")]); const first = m.commit(r);
    m.commit(request("later", [edit("C", "B")]));
    expect(m.commit(r)).toEqual(first);
    expect(() => m.commit(request("edit", [edit("X")]))).toThrow("OP_ID_REUSED");
    expect(m.snapshot().boundary).toBe(3);
  });
  it("rejects missing objects and rolls back a preceding action in the same group", () => {
    const m = setup(); const broken = create("G", "G1", "other"); broken.payload.objects = ["not-durable"];
    const before = m.snapshot(); expect(() => m.commit(request("batch", [edit("B"), broken]))).toThrow("OBJECT_MISSING");
    expect(m.snapshot()).toEqual(before);
  });
  it("never loses rename sources on path/CAS failure and prevents location ABA", () => {
    const m = setup(); m.commit(request("other", [create("G", "G1", "occupied")]));
    const move: Action = { type: "move", fileId: "F", expectedLocation: "L-F", location: { revision: "L2", pathKey: "occupied", encryptedPath: "enc" } };
    const before = m.snapshot(); expect(() => m.commit(request("move", [move]))).toThrow("PATH_OCCUPIED");
    expect(m.snapshot()).toEqual(before);
    move.location.pathKey = "free"; m.commit(request("move", [move]));
    expect(() => m.commit(request("stale", [{ ...move, location: { ...move.location, revision: "L3" } }]))).toThrow("LOCATION_STALE");
    expect(() => m.commit(request("aba", [{ ...move, expectedLocation: "L2", location: { ...move.location, revision: "L-F" } }]))).toThrow("LOCATION_STALE");
  });
  it("publishes an atomic namespace swap as one unsplit event", () => {
    const m = setup(); m.commit(request("other", [create("G", "G1", "other")]));
    m.commit(request("swap", [
      { type: "move", fileId: "F", expectedLocation: "L-F", location: { revision: "LF2", pathKey: "other", encryptedPath: "enc" } },
      { type: "move", fileId: "G", expectedLocation: "L-G", location: { revision: "LG2", pathKey: "opaque-path", encryptedPath: "enc" } },
    ]));
    expect(m.pull("E", 2, 1)[0]?.actions).toHaveLength(2);
  });
  it("requires snapshot for expired log and reconciliation for old epoch", () => {
    const m = setup(); const frozen = m.snapshot(); m.commit(request("B", [edit("B")]));
    expect(frozen.boundary).toBe(1); expect(frozen.files[0]?.heads).toEqual(["A"]);
    expect(m.pull("E", frozen.boundary).map(c => c.seq)).toEqual([2]);
    m.expireLogThrough(1); expect(() => m.pull("E", 0)).toThrow("NEED_SNAPSHOT");
    expect(() => m.pull("old-epoch", 2)).toThrow("EPOCH_CHANGED");
    expect(() => m.commit({ ...request("old", [edit("C")]), epoch: "old-epoch" })).toThrow("EPOCH_CHANGED");
    expect(() => m.commit({ ...request("future", [edit("C")]), requiredFeatures: ["future"] })).toThrow("UNSUPPORTED_PROTOCOL");
  });
  it("does not leak mutable snapshots, requests or receipts back into state", () => {
    const m = setup(); const r = request("B", [edit("B")]); const receipt = m.commit(r);
    r.actions.length = 0; receipt.seq = 99; const snapshot = m.snapshot(); snapshot.files[0]!.heads.length = 0;
    expect(heads(m)).toEqual(["B"]); expect(m.pull("E", 1)[0]?.actions).toHaveLength(1);
  });
});

describe("generated state histories", () => {
  it("all random offline branches survive exactly as graph-maximal heads; retries never advance seq", () => {
    fc.assert(fc.property(fc.array(fc.record({ parent: fc.nat(), device: fc.integer({ min: 0, max: 4 }), deleted: fc.boolean(), retries: fc.integer({ min: 0, max: 3 }) }), { minLength: 1, maxLength: 80 }), steps => {
      const m = setup(); const ids = ["A"]; const parents = new Map<string, string[]>([["A", []]]);
      steps.forEach((s, i) => {
        const next = `R${i}`; const parent = ids[s.parent % ids.length]!;
        const r = request(`O${i}`, [edit(next, parent, s.deleted ? "deleted" : "file")], `device-${s.device}`);
        const receipt = m.commit(r);
        for (let retry = 0; retry < s.retries; retry++) expect(m.commit(r)).toEqual(receipt);
        ids.push(next); parents.set(next, [parent]);
        // Independent oracle: heads = revisions which are never the direct parent of another revision.
        const consumed = new Set([...parents.values()].flat());
        expect(heads(m)).toEqual(ids.filter(x => !consumed.has(x)).sort());
        expect(m.snapshot().revisions).toHaveLength(ids.length);
        expect(m.snapshot().boundary).toBe(ids.length);
      });
    }), { numRuns: 200, seed: 20261014 });
  });
  it("permuting independently authored branches and redeliveries yields the same graph", () => {
    fc.assert(fc.property(fc.shuffledSubarray(["B", "C", "D", "E", "F"], { minLength: 5, maxLength: 5 }), order => {
      const m = setup(); order.forEach(x => { const r = request(x, [edit(x)], x); m.commit(r); m.commit(r); });
      expect(heads(m)).toEqual(["B", "C", "D", "E", "F"]);
      expect(m.snapshot().boundary).toBe(6);
    }), { numRuns: 120, seed: 20261015 });
  });
});
