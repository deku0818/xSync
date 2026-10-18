# xSync PostgreSQL 部署入口

用于全新管理后台模式，详见 [部署说明](../../../docs/deployment/postgres.md)。

- `docker-compose.yaml`：内置管理前端的 xSync 与 PostgreSQL，TLS、内部数据库网络、非 root 服务。
- `.env.example`：镜像与已有 Nginx 网络，默认 `xsync-server:local`，需先从当前源码构建。
- `configure.py`：读取私有管理员密码文件与 TLS 证书，准备全新 Linux 部署；已有 secrets/data 时拒绝覆盖。

管理页面 `/admin/`，用户在插件中创建独立加密库。本轮没有空间统计、配额、SQLite 或旧库迁移。旧 Release 镜像不能用于新流程。
