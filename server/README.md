# 服务端职责

已实现实验性 Go + pgx HTTP 服务、PostgreSQL 元数据、先 fsync 再发布的不可变密文对象及真实数据库合同测试。开发 PG **只使用 Docker**，见 `compose.dev.yaml`；不得在宿主机安装/运行 PG。

从项目根运行 `npm run desktop:setup`、`npm run test:desktop`、`npm run desktop:start`。完整操作见 [电脑验证](../docs/testing/desktop.md)。数据库和 HTTP 都只绑定 loopback；这不是生产部署。

推荐 Go + PostgreSQL，负责设备鉴权、条件提交、命名空间、版本关系、幂等结果、变更日志、不可变密文对象、历史 / GC 与联合备份。服务端不持有文件解密密钥。

0.0.6 新增 GET `/devices`、PUT `/device/profile`：同 vault 规范化名称唯一、每设备加密快照、revision CAS 与丢回执重试；授权只能更新自身，服务端不解密规则。新增独立根 branch 和解决时的位置 CAS。对象仍限制为 16 MiB 密文，客户端以小块支持 100 MB 文件；服务端不可声称直接校验 E2EE 明文长度。

当前接口 `/handshake`、`/objects/{id}`、`/commits`、`/changes`、`/snapshots`，以及 `/events/tickets` + WebSocket `/events`。设备令牌摘要鉴权、请求绑定、每库行锁发布、冻结快照、墓碑/并发版本和条件解决已接入；事件是单次票据认证的提示，HTTP 是补齐依据。尚无生产设备管理、多实例通知协调、GC、对象租约回收、联合备份/还原或协议迁移工具。目前提交载入/发布按库状态，规模和性能尚未验收，不能以此声明大库支持。
