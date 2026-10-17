# 同步协议

本目录保存客户端与服务端共享的 TypeScript 类型、运行时校验和可执行参考模型。当前源码的语义与兼容边界见 [MODEL.md](MODEL.md)，部署升级要求见[服务部署](../docs/DEPLOYMENT.md#源码升级与协议兼容)。

| 文件 | 职责 |
| --- | --- |
| `src/types.ts`、`src/wire.ts` | 提交类型与严格运行时校验 |
| `src/model.ts`、`src/client-model.ts` | 完整因果图和接收/应用游标参考模型 |
| `src/metadata.ts` | 基线凭据、请求坐标、确认与当前头投影 |
| `src/objects.ts` | 密文对象格式、身份与能力协商 |
| `src/continuity.ts` | 设备连续性请求与标记 |
| `src/enrollment.ts`、`src/client-profile.ts` | 设备接入与加密配置快照 |

HTTP 负责可靠补齐，WebSocket 只发送事件提示，不直接应用文件或推进游标。Go 入口同样执行严格校验。协议尚未冻结为独立发布的 OpenAPI / JSON Schema 兼容合同。

运行 `npm test` 验证模型；真实数据库和多客户端测试见[开发流程](../docs/testing/DEVELOPMENT.md)。
