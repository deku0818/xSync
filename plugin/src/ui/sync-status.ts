import type { EngineStatus, SyncActivity } from "../sync/engine";

export function syncActivityLabel(activity?: SyncActivity): string {
  return activity === "uploading" ? "正在上传文件" : activity === "downloading" ? "正在接收更改" : activity === "applying" ? "正在应用更改" : "正在核对文件";
}

/** Active work supersedes prior run errors; actual conflicts stay visible during sync. */
export function syncDisplayState(status: EngineStatus | undefined, ready: boolean, enabled: boolean, running: boolean, localPending: boolean) {
  if (!ready) return "locked";
  if (!enabled) return "paused";
  if (status?.conflicts) return "conflict";
  if (running || status?.activity) return "syncing";
  if (status?.state === "needs-attention") return "attention";
  if (status?.state === "pending" || localPending) return "pending";
  return "complete";
}
