# 验证计划

当前 `npm test` 可执行协议定向/属性测试和探针辅助模块测试；`npm run check` 同时检查类型和构建。测试范围、证据与开发流程见 [DEVELOPMENT.md](../docs/testing/DEVELOPMENT.md)。

当前 0.0.6：59 默认测试 + 14 真实 Docker PG/事件/profile 合同（race）+ 16 双客户端集成通过。新增配置字段隔离、名称唯一与加密快照、范围变化、独立接入/归档中断、合并草稿/位置 CAS、准确 100 MB 传输及接收端先跳过后补齐。真实 A/B 界面与文件证据见 [本轮验收](../docs/testing/desktop-v006-2026-10-15.md)。

`protocol/` 测内存语义，`probe/` 保留能力探针测试。`desktop/` 含核心单测和可选双客户端集成；`npm run test:desktop` 另跑真实 Docker PostgreSQL 的 Go 合同/race 测试。集成使用真实文件/HTTP/PG、fake IndexedDB；真实 Obsidian A/B 双窗口已通过编辑往返和冲突 UI 验证；物理双机、强杀/备份和 iPhone/Android 尚待验收。最新证据见 [电脑验证](../docs/testing/desktop.md)。

实施后按风险覆盖：

- 协议状态机与属性测试：因果、分支、幂等、位置唯一性、过期审阅。
- 真实数据库与对象存储合同：事务、序号发布、对象耐久、引用与 GC。
- 故障注入：每个持久化边界退出、重复 / 丢失请求、磁盘满、损坏密文。
- 多设备 E2E：离线编辑、删除与编辑、重命名与编辑、同路径独立创建、配置同步。
- 真机与恢复：iOS / Android 资源、全部目标平台文件规则、备份还原与旧设备重连。

详细不变量见 `../docs/DECISIONS.md`；HTML 演示不是这些测试。
