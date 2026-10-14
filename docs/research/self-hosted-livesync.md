# Self-hosted LiveSync 参考分析

分析日期：2026-10-14。静态源码与文档检查，没有运行上游插件或测试。

## 参考快照

- 主插件：[vrtmrz/obsidian-livesync @ 0956663f7bf97e2d778a9955f359997a29c2f71f](https://github.com/vrtmrz/obsidian-livesync/tree/0956663f7bf97e2d778a9955f359997a29c2f71f)。读取时 package.json 为 1.0.36，锁定 Commonlib 0.1.39。
- 核心库：[vrtmrz/livesync-commonlib @ 15ed37bbcf0265202771914eed8d3a34c79bbbe5](https://github.com/vrtmrz/livesync-commonlib/tree/15ed37bbcf0265202771914eed8d3a34c79bbbe5)。主分支快照不等于已验证的发布版本。

## 分层与同步链路

主插件负责 Obsidian 文件 / 事件、UI、生命周期与服务组装；Commonlib 负责文件映射、内容块、数据库访问、加密、复制、冲突与扫描。CouchDB 模式为：

```text
Vault ↔ 文件处理 / 队列 ↔ 本地 PouchDB ↔ 远端复制与加密 ↔ CouchDB
```

本地变化先写本地数据库，再复制；远端变化先到本地数据库，再经内容重建、冲突检查和任务队列写回 Vault。因此数据库复制完成不等于 Vault 已应用完成。

## 重要机制

| 机制 | 调研结论 | 对独立项目的启发 |
| --- | --- | --- |
| Metadata + Chunk | 文件元数据引用有序内容块；块可复用 | 内容对象与版本分开，但依赖与 GC 必须显式管理 |
| 文件身份 | 普通文档 ID 由路径派生 | 独立方案采用稳定随机身份，单独管理位置 |
| 复制 | PouchDB / CouchDB 增量复制与检查点 | 可以参考补齐思想，不必继承复制协议 |
| 缺块 | 先写块再写元数据，也可能在复制后先观察到元数据 | 依赖未完整时不能写出不完整文件 |
| 冲突 | 修订树 winner 不证明内容更安全或更值得保留 | 保存并发分支，不以 winner 或时间替用户选择 |
| 版本来源 | 设备记录准确 displayed_revision | 编辑必须扩展用户实际看到的分支 |
| 删除 | 逻辑文件删除与数据库 tombstone 分离 | 删除是一份可比较的意图，不能直接消灭并发编辑 |
| 重命名 | 跨路径通常先存目标、再逻辑删除源 | 目标失败保留源；独立模型可使位置与内容变更交换 |
| 启动恢复 | 部分事件快照恢复 + 全库扫描 | 队列并非完整内容日志，恢复前必须复核现状 |
| 加密 | 内容、路径 / 属性与内部元数据有独立条件和兼容路径 | 新协议明确统一保护范围与可见控制信息 |
| 配置 | Hidden File Sync 与 Customisation Sync 不能重叠管理同文件 | 一套共享分类，清楚的文件所有权与应用规则 |
| 历史 / GC | 修订存在不保证所需旧块仍存在 | 显式历史保留、引用保护与联合备份 |

## 参考价值与边界

保留它关于准确版本来源、持久化任务、删除复核、缺块等待和真实故障测试的经验。独立设计不必复制多远端、P2P、旧加密和分块格式、复杂设置矩阵或原有数据格式。

Commonlib README 明确说明：库处于 pre-1.0，`compat/*` 是迁移接口，完整高层客户端工厂尚未实现。因此不能假设它是可即插即用的完整同步 SDK。

用户后来明确：**允许独立实现，工作量不是限制，LiveSync 只是参考**。当前主方案已经转向自定义协议、PostgreSQL 和密文对象存储，并非 fork 决定。

## 源码与文档入口

- [插件入口与服务组装](https://github.com/vrtmrz/obsidian-livesync/blob/0956663f7bf97e2d778a9955f359997a29c2f71f/src/main.ts)
- [数据结构](https://github.com/vrtmrz/obsidian-livesync/blob/0956663f7bf97e2d778a9955f359997a29c2f71f/docs/datastructure.md)
- [冲突与版本来源](https://github.com/vrtmrz/obsidian-livesync/blob/0956663f7bf97e2d778a9955f359997a29c2f71f/docs/specs_conflict_resolution.md)
- [缺块与等待](https://github.com/vrtmrz/obsidian-livesync/blob/0956663f7bf97e2d778a9955f359997a29c2f71f/docs/design_docs/chunk_retrieval_and_waiting.md)
- [垃圾回收与历史限制](https://github.com/vrtmrz/obsidian-livesync/blob/0956663f7bf97e2d778a9955f359997a29c2f71f/docs/specs_garbage_collection.md)
- [Commonlib 接口边界](https://github.com/vrtmrz/livesync-commonlib/blob/15ed37bbcf0265202771914eed8d3a34c79bbbe5/readme.md)
- [事件与文件反映边界](https://github.com/vrtmrz/livesync-commonlib/blob/15ed37bbcf0265202771914eed8d3a34c79bbbe5/docs/storage-events-and-reflection.md)
- [加密转换](https://github.com/vrtmrz/livesync-commonlib/blob/15ed37bbcf0265202771914eed8d3a34c79bbbe5/src/pouchdb/encryption.ts)

其他数据库、标准与密码学来源在 HTML 第 12 节。此摘要记录当时检查，不将上游文档的计划或验证描述作为本项目的实测结论。
