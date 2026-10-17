# 服务端

Go/pgx HTTP 与 WebSocket 服务，使用 PostgreSQL 保存元数据，持久目录保存不可变密文对象。服务端不持有内容解密密钥。数据库使用项目专属 Docker 资源。

- [部署与管理](../docs/DEPLOYMENT.md)：HTTPS、设备接入/撤销、自动清理、升级与备份。
- [PostgreSQL Compose 模板](deploy/postgres/README.md)。
- [开发环境](../docs/testing/desktop.md)与[测试流程](../docs/testing/DEVELOPMENT.md)。

接口包括接入、handshake、对象、提交、增量、冻结快照、设备配置和单次票据认证的事件连接。HTTP 负责补齐，事件只作提示；iOS Origin 精确允许 `capacitor://localhost`，仍要求事件票据。

普通监听默认使用 loopback；非 loopback 正式监听要求 TLS。开发 LAN 开关仅用于隔离测试 schema。密文对象请求上限为 16 MiB，服务端不能验证端到端加密内容的明文长度。

当前源码包含尚未发布的内容保护、元数据/对象回收和设备连续性协议，须与同一提交构建的插件配套使用。多实例通知、生产容量、生产联合备份还原与原生设备验收尚未完成。
