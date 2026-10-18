import { expect, it } from "vitest";
import type { EngineStatus } from "../../plugin/src/sync/engine";
import { syncPresentation, syncDisplayState } from "../../plugin/src/ui/sync-status";

const status: EngineStatus = { state: "needs-attention", outbox: 313, inbox: 6, conflicts: 0, errors: ["OFFLINE"] };
it("shows current work instead of stale errors while retaining actual conflict and pause warnings", () => {
  expect(syncDisplayState(status, true, true, true, false)).toBe("syncing");
  expect(status.errors).toEqual(["OFFLINE"]);
  expect(syncDisplayState(status, true, true, false, false)).toBe("waiting");
  expect(syncDisplayState({ ...status, conflicts: 1 }, true, true, true, false)).toBe("conflict");
  expect(syncDisplayState(status, true, false, true, false)).toBe("paused");
  expect(syncDisplayState(status, false, true, true, false)).toBe("locked");
});
it("distinguishes an active upload, queued work, and completion", () => {
  const complete: EngineStatus = { state: "complete", outbox: 0, inbox: 0, conflicts: 0, errors: [] };
  expect(syncDisplayState({ ...complete, activity: "uploading" }, true, true, false, false)).toBe("syncing");
  expect(syncPresentation({ ...complete, activity: "uploading" }, true, true, false, false).label).toBe("正在同步");
  expect(syncDisplayState(complete, true, true, false, true)).toBe("pending");
  expect(syncDisplayState(complete, true, true, false, false)).toBe("complete");
});
it("explains unsupported files without masking a global recovery or authorization failure", () => {
  const unsupported: EngineStatus = { state: "needs-attention", outbox: 0, inbox: 0, conflicts: 0, errors: ["UNSUPPORTED_PATH"], issues: [{ path: "bad?.md", code: "UNSUPPORTED_PATH", phase: "checking" }] };
  expect(syncPresentation(unsupported, true, true, false, false).label).toBe("部分文件未同步");
  expect(syncPresentation({ ...unsupported, errors: ["UNSUPPORTED_PATH", "RECOVERY_RECONCILIATION_REQUIRED"] }, true, true, false, false).label).toBe("同步未完成");
  expect(syncPresentation({ ...unsupported, errors: ["UNAUTHORIZED"] }, true, true, false, false).label).toBe("需要重新授权");
});


it("keeps temporary failures quiet without masking safety or mixed failures", () => {
  expect(syncPresentation({ ...status, errors: ["CONTENT_BUSY"] }, true, true, false, false)).toMatchObject({ state: "retrying", label: "正在重试" });
  for (const errors of [["RECOVERY_RECONCILIATION_REQUIRED"], ["OBJECT_CORRUPT"], ["APPLY_RECOVERY_FAILED: network.md"], ["NETWORK_TIMEOUT", "UPLOAD_STAGE_UNAVAILABLE"]]) {
    expect(syncPresentation({ ...status, errors }, true, true, false, false)).toMatchObject({ state: "attention", label: "同步未完成" });
  }
  expect(syncPresentation({ ...status, conflicts: 1, errors: ["NETWORK_TIMEOUT"] }, true, true, false, false).state).toBe("conflict");
});
