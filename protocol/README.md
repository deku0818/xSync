# 协议定义职责

已进入实验性协议模型 v0：`src/types.ts` 定义内部类型，`src/model.ts` 实现内存语义，`src/client-model.ts` 演示接收/应用游标边界。完整合同与限制见 [MODEL.md](MODEL.md)。

`src/wire.ts` 提供实验 v0 严格运行时校验，Go 拒绝未知/重复字段和缺少的版本。HTTP 补齐与单次票据的 WebSocket 提示已接入；提示不直接应用文件或推进游标。正式 OpenAPI / JSON Schema、固定加密向量和跨语言发布合同仍待完成，v0 不作为发布兼容承诺。

先证明因果、幂等、删除和恢复规则，不能仅列接口而缺少状态语义。
