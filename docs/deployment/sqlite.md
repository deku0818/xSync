# SQLite 部署状态

**xSync 0.1.1 没有 SQLite 服务端后端，因此当前没有可运行的 SQLite Compose 版本。** 本轮按用户确认使用 PostgreSQL，部署见 [PostgreSQL 说明](postgres.md)。

服务端目前直接使用 Go `pgx`、PostgreSQL 事务/行锁、JSONB 和可延迟约束。不能通过修改 DSN、安装 SQLite 或增加一个 SQLite 容器来替代 PostgreSQL。客户端的 IndexedDB/Dexie 本地状态也不是 SQLite 服务端。

若未来加入 SQLite，需要实现数据库适配及对应 schema/迁移，重新验证幂等提交、并发与因果头、接入/撤销、快照、故障恢复和数据库/对象联合备份。SQLite 的锁、外键和事务边界必须保持原协议合同，不能降低冲突保护或靠上传顺序选择版本。

当前不指定 SQLite 版本，不提供误导性的 Docker Compose 文件，也不将该后端列为已支持能力。CouchDB/LiveSync 数据同样不能直接作为 xSync 数据库打开。
