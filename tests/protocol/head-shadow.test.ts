import { expect, it } from "vitest";
import fc from "fast-check";
import { project } from "../../plugin/src/sync/projection";
import type { Action, FileState, Revision } from "../../protocol/src/types";

it("production compact projection matches the complete graph after evicting every non-head revision", () => {
  fc.assert(fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 150 }), choices => {
    const fullFiles = new Map<string, FileState>(), compactFiles = new Map<string, FileState>();
    const full = new Map<string, Revision>(), compact = new Map<string, Revision>();
    for (const [i,choice] of choices.entries()) {
      const id = `R${i}`, parents = [...full.keys()], heads = fullFiles.get("F")?.heads ?? [];
      const payload = { kind: "file" as const, keyEpoch: 1, encryptedManifest: "fixture", objects: [] };
      let action: Action;
      if (!i) action = { type: "create", fileId: "F", revisionId: id, payload, location: { revision: "L", pathKey: "0".repeat(64), encryptedPath: "fixture" } };
      else if (choice % 5 === 0) action = { type: "branch", fileId: "F", revisionId: id, payload };
      else if (choice % 5 === 1 && heads.length > 1) action = { type: "resolve", fileId: "F", revisionId: id, payload, observedHeads: [...heads], decision: { kind: "manual" } };
      else action = { type: "edit", fileId: "F", revisionId: id, payload, displayedRevision: parents[choice % parents.length]! };
      const change = { seq: i + 1, opId: id, deviceId: "D", actions: [action] };
      project(fullFiles, full, change); project(compactFiles, compact, change, true);
      expect(compactFiles).toEqual(fullFiles);
      const retained = new Set(compactFiles.get("F")!.heads);
      for (const key of compact.keys()) if (!retained.has(key)) compact.delete(key);
      expect(compact.size).toBe(retained.size);
    }
  }), { numRuns: 200 });
});
