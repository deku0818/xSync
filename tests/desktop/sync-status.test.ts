import { expect, it } from "vitest";
import type { EngineStatus } from "../../plugin/src/sync/engine";
import { syncActivityLabel, syncDisplayState } from "../../plugin/src/ui/sync-status";

const status: EngineStatus = { state: "needs-attention", outbox: 313, inbox: 6, conflicts: 0, errors: ["OFFLINE"] };
it("shows current work instead of stale errors while retaining actual conflict and pause warnings", () => {
  expect(syncDisplayState(status, true, true, true, false)).toBe("syncing");
  expect(status.errors).toEqual(["OFFLINE"]);
  expect(syncDisplayState(status, true, true, false, false)).toBe("attention");
  expect(syncDisplayState({ ...status, conflicts: 1 }, true, true, true, false)).toBe("conflict");
  expect(syncDisplayState(status, true, false, true, false)).toBe("paused");
  expect(syncDisplayState(status, false, true, true, false)).toBe("locked");
});
it("distinguishes an active upload, queued work, and completion", () => {
  const complete: EngineStatus = { state: "complete", outbox: 0, inbox: 0, conflicts: 0, errors: [] };
  expect(syncDisplayState({ ...complete, activity: "uploading" }, true, true, false, false)).toBe("syncing");
  expect(syncActivityLabel("uploading")).toBe("正在上传文件");
  expect(syncDisplayState(complete, true, true, false, true)).toBe("pending");
  expect(syncDisplayState(complete, true, true, false, false)).toBe("complete");
});
