import { chinese, type Translator } from "../i18n";
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

export function syncPresentation(status: EngineStatus | undefined, ready: boolean, enabled: boolean, running: boolean, localPending: boolean, t: Translator = chinese): { state: SyncDisplayState; label: string; message: string } {
  const state = syncDisplayState(status, ready, enabled, running, localPending);
  const labels: Record<SyncDisplayState, string> = {
    locked: t("需要连接"), paused: t("已暂停"), conflict: t("{0} 个文件有冲突", status?.conflicts ?? 0), syncing: t("正在同步"),
    waiting: t("等待连接"), retrying: t("正在重试"), attention: t("同步未完成"), pending: t("等待同步"), complete: t("已同步"),
  };
  const messages: Record<SyncDisplayState, string> = {
    locked: t("请在同步设置中连接此笔记库。"), paused: t("笔记可以照常编辑，恢复后会自动同步。"),
    conflict: t("双方内容均保留，其他文件继续同步。"), syncing: t("正在同步你的更改。"),
    waiting: t("更改已保存在本机，连接恢复后自动同步。"), retrying: t("暂时没有同步成功，正在自动重试。你可以继续编辑。"),
    attention: t("同步暂时无法完成，本机笔记与待处理内容仍保留。"), pending: t("更改已保存在本机，将自动同步。"),
    complete: t("更改已同步，无需其他操作。"),
  };
  if (state === "attention" && status?.errors.some(error => /^(UNAUTHORIZED|USER_DISABLED|VAULT_NOT_FOUND)$/.test(error))) {
    return { state, label: t("需要重新授权"), message: t("请向管理员确认当前访问 key，并在同步设置中重新保存。本地笔记与库解密材料仍保留。") };
  }
  if (state === "attention" && status?.issues?.length && status.errors.every(error => /^(UNSUPPORTED_PATH|UNSAFE_PATH)$/.test(error))) {
    return { state, label: t("部分文件未同步"), message: status.outbox || status.inbox ? t("正常文件继续同步，下面这些文件需要处理。") : t("其他文件已同步，下面这些文件需要处理。") };
  }
  if (state === "syncing" && status?.activity) {
    const phases = { checking: t("正在核对文件。"), uploading: t("正在上传文件。"), downloading: t("正在接收更改。"), applying: t("正在应用更改。") };
    return { state, label: labels[state], message: phases[status.activity] };
  }
  return { state, label: labels[state], message: messages[state] };
}
