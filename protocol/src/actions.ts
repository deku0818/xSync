import type { Action } from "./types.js";

/** A keep-both decision includes one additional create in the same atomic group. */
export function actionEntries(actions: readonly Action[]): Action[] {
  return actions.flatMap(function expandAction(action: Action): Action[] {
    if (action.type === "resolve" && action.decision.kind === "keep-both") return [action, action.decision.companion];
    return [action];
  });
}
