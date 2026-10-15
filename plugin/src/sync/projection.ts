import type { Action, Change, FileState, Revision } from "../../../protocol/src/types";
import { canonical } from "../../../protocol/src/model";

/** Build a causal local view from complete groups, preserving every revision. */
export function project(files: Map<string, FileState>, revisions: Map<string, Revision>, change: Change): string[] {
  const affected = new Set<string>();
  const add = (a: Exclude<Action, { type: "move" }>, parents: string[], selectedFrom?: string) => {
    const f = files.get(a.fileId); if (!f) throw new Error("LOG_FILE_MISSING");
    const r: Revision = { id: a.revisionId, fileId: a.fileId, parents, deviceId: change.deviceId, payload: a.payload };
    if (selectedFrom) r.selectedFrom = selectedFrom;
    const prior = revisions.get(r.id); if (prior && canonical(prior) !== canonical(r)) throw new Error("REVISION_CHANGED");
    const ancestors = new Set<string>(); const todo = [...parents];
    while (todo.length) { const next = todo.pop()!; if (ancestors.has(next)) continue; const parent = revisions.get(next);
      if (!parent || parent.fileId !== a.fileId) throw new Error("LOG_PARENT_MISSING"); ancestors.add(next); todo.push(...parent.parents); }
    revisions.set(r.id, r); f.heads = [...f.heads.filter(x => !ancestors.has(x)), r.id].sort(); affected.add(f.id);
  };
  const create = (a: Extract<Action, { type: "create" }>, source?: string) => {
    if (files.has(a.fileId) || a.payload.kind === "deleted") throw new Error("LOG_FILE_EXISTS");
    files.set(a.fileId, { id: a.fileId, entryKind: a.payload.kind, location: a.location, heads: [] }); add(a, [], source);
  };
  for (const a of change.actions) {
    if (a.type === "create") { create(a); continue; }
    const f = files.get(a.fileId); if (!f) throw new Error("LOG_FILE_MISSING"); affected.add(f.id);
    if (a.type === "move") { if (f.location.revision !== a.expectedLocation) throw new Error("LOG_LOCATION_STALE"); f.location = a.location; }
    else if (a.type === "branch") add(a, []);
    else if (a.type === "edit") add(a, [a.displayedRevision]);
    else {
      if (a.expectedLocation !== undefined && a.expectedLocation !== f.location.revision) throw new Error("LOG_REVIEW_STALE");
      if (canonical([...f.heads].sort()) !== canonical([...a.observedHeads].sort())) throw new Error("LOG_REVIEW_STALE");
      if (a.decision.kind === "keep-both") create(a.decision.companion, a.decision.companionSource);
      add(a, a.observedHeads, a.decision.kind === "manual" ? undefined : a.decision.selectedRevision);
    }
  }
  return [...affected];
}
export function isAncestor(ancestor: string, head: string, revisions: Map<string, Revision>): boolean {
  const seen = new Set<string>(); const todo = [head];
  while (todo.length) { const id = todo.pop()!; if (id === ancestor) return true; if (seen.has(id)) continue; seen.add(id); todo.push(...(revisions.get(id)?.parents ?? [])); }
  return false;
}
