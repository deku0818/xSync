import { RemoteError } from "./transport";

export type ConnectionStep = "server" | "name" | "authorization" | "key" | "storage";
export interface ConnectionCheck { step: ConnectionStep; state: "running" | "passed" | "failed"; message?: string }
export type ConnectionObserver = (check: ConnectionCheck) => void;
/** Never expose a raw native exception, server response or credential in the configuration UI. */
export function connectionFailure(error: unknown, step: ConnectionStep): { step: ConnectionStep; message: string } {
  const code = error instanceof Error ? error.message : "";
  if (error instanceof RemoteError && (error.status === 401 || error.status === 403 || error.code === "UNAUTHORIZED")) return { step: "authorization", message: "服务器已响应，但设备授权被拒绝。请检查设备授权。" };
  if (code === "DEVICE_NAME_TAKEN") return { step: "name", message: "客户端名称已被占用，请换一个名称。" };
  if (step === "name") return { step, message: "客户端名称无法保存，请检查名称和服务端版本。" };
  if (code === "HANDSHAKE_MISMATCH") return { step: "authorization", message: "服务器的库或设备信息不匹配，请确认服务器地址。" };
  if (code === "RECOVERY_RECONCILIATION_REQUIRED") return { step: "authorization", message: "服务器进度与本机记录不一致，需要先核对恢复状态。" };
  if (code === "KEY_PACKAGE_CHANGED") return { step: "key", message: "服务器的密钥信息已变化，需要先核对，无法覆盖现有配置。" };
  if (code === "CONNECTION_KEY_REQUIRED") return { step: "key", message: "请输入同步密钥；首次配置需要填写密钥。" };
  if (code === "PLUGIN_UNLOADED") return { step, message: "插件已关闭，请重新打开设置后测试。" };
  if (code.startsWith("IOS_")) return { step: "storage", message: "无法访问此设备的系统钥匙串，配置尚未保存。请解锁设备后重试；凭据不可用时需重新配置。" };
  if (step === "server") {
    if (code === "HTTPS_REQUIRED") return { step, message: "请使用 HTTPS 地址；本机测试服务可以使用 HTTP。" };
    if (code === "INVALID_ENDPOINT") return { step, message: "请输入完整的服务器地址，不要包含账号、路径或查询参数。" };
    if (code === "NETWORK_TIMEOUT") return { step, message: "服务器连接超时，请检查地址和网络。" };
    return { step, message: "无法连接同步服务，请检查服务器地址、网络和服务状态。" };
  }
  if (step === "key") return { step, message: "同步密钥校验失败，请确认与此服务器使用的密钥一致。" };
  return { step, message: "连接与密钥校验通过，但无法安全保存配置。请检查本机安全存储和磁盘。" };
}
