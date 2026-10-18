import type { EngineStatus } from "../sync/engine";

export type SyncDisplayState = "locked" | "paused" | "conflict" | "syncing" | "waiting" | "retrying" | "attention" | "pending" | "complete";

function isConnectionFailure(error: string): boolean {
  const message = error.replace(/^Error:\s*/, "");
  const code = /^([A-Z][A-Z0-9_]{2,})(?=$|[:\s])/.exec(message)?.[1];
  if (code) return /^(NETWORK_TIMEOUT|OFFLINE|ENOTFOUND|ECONN[A-Z]+)$/.test(code);
  return /Failed to fetch|fetch failed|^Network|^TypeError:.*(?:network|fetch)|net::ERR_|NSURLError/i.test(message);
}

export function syncDisplayState(status: EngineStatus | undefined, ready: boolean, enabled: boolean, running: boolean, localPending: boolean): SyncDisplayState {
  if (!ready) return "locked";
  if (!enabled) return "paused";
  if (status?.conflicts) return "conflict";
  if (running || status?.activity) return "syncing";
  const errors = status?.errors ?? [];
  if (errors.length && errors.every(isConnectionFailure)) return "waiting";
  if (errors.length && errors.every(error => /^(CONTENT_BUSY|OBJECT_BUSY|LOCAL_EDITOR_CHANGES_PENDING|HTTP_429|HTTP_50[234])$/.test(error))) return "retrying";
  if (status?.state === "needs-attention") return "attention";
  if (status?.state === "pending" || localPending) return "pending";
  return "complete";
}

export function syncPresentation(status: EngineStatus | undefined, ready: boolean, enabled: boolean, running: boolean, localPending: boolean): { state: SyncDisplayState; label: string; message: string } {
  const state = syncDisplayState(status, ready, enabled, running, localPending);
  const labels: Record<SyncDisplayState, string> = {
    locked: "需要连接", paused: "已暂停", conflict: `${status?.conflicts ?? 0} 个文件有冲突`, syncing: "正在同步",
    waiting: "等待连接", retrying: "正在重试", attention: "同步未完成", pending: "等待同步", complete: "已同步",
  };
  const messages: Record<SyncDisplayState, string> = {
    locked: "请在同步设置中连接此笔记库。", paused: "笔记可以照常编辑，恢复后会自动同步。",
    conflict: "双方内容均保留，其他文件继续同步。", syncing: "正在同步你的更改。",
    waiting: "更改已保存在本机，连接恢复后自动同步。", retrying: "暂时没有同步成功，正在自动重试。你可以继续编辑。",
    attention: "同步暂时无法完成，本机笔记与待处理内容仍保留。", pending: "更改已保存在本机，将自动同步。",
    complete: "更改已同步，无需其他操作。",
  };
  if (state === "attention" && status?.errors.some(error => /^(UNAUTHORIZED|USER_DISABLED|VAULT_NOT_FOUND)$/.test(error))) {
    return { state, label: "需要重新授权", message: "请向管理员确认当前访问 key，并在同步设置中重新保存。本地笔记与库解密材料仍保留。" };
  }
  return { state, label: labels[state], message: messages[state] };
}
