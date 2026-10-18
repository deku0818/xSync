# PostgreSQL／TLS Compose 部署

对应尚未发布的管理后台版本，仅用于全新数据库与新库。不要复用旧版服务器初始化包或数据库。服务端和插件须同提交构建，SQLite 后续实现。

## 准备

在仓库根目录构建 `docker build -f server/Dockerfile -t xsync-server:local .`。将 `server/deploy/postgres/` 复制到新的部署目录，例如 `/srv/xsync`。复制 `.env.example` 为 `.env`，填写自己的镜像和已有 Nginx Docker 网络。

同时填写必需的 `XSYNC_TRUSTED_PROXIES`：使用 Nginx 容器在该网络中的固定 IP，IPv4 加 `/32`、IPv6 加 `/128`，多个代理用逗号分隔。代理地址变化时需同步更新并重启 server。该设置用于按真实访问者限流，不能填写公网或不受控共享网络范围；模板中的 Nginx 会覆盖客户端传入的 `X-Real-IP`。

准备有效 TLS 证书及一个私有管理密码文件（至少 12 个字符，单行）。在 Linux 部署机器执行：

```sh
sudo python3 configure.py \
  --admin-password-file /private/path/admin-password.txt \
  --tls-cert /private/path/fullchain.pem \
  --tls-key /private/path/privkey.pem \
  --directory /srv/xsync
```

脚本在已有 secrets 或持久数据时拒绝覆盖。它生成随机数据库密码、私有环境文件、管理员密码副本、TLS 副本及对象目录，并设置容器用户权限；不打印凭据，不生成任何用户库或内容密钥。

`secrets/server.env` 只包含数据库 DSN，`secrets/admin-password.txt` 通过 Docker secret 提供给非 root 服务进程。两者都属于私有运行材料，不能提交 Git。配置和数据只在运行时挂载，不进入镜像。

## 启动

```sh
cd /srv/xsync
docker compose config --quiet
docker compose up -d --wait --wait-timeout 180
docker compose ps
```

PG 只加入内部数据库网络；服务端同时加入已有 Nginx 代理网络。两者都不映射公网宿主端口。服务端监听 TLS，Nginx 示例见 `server/deploy/nginx/xsync.conf.example`，需保留事件连接的 Upgrade／Connection 转发。

浏览器打开 `https://sync.example.com/admin/`。登录、创建用户、保存一次展示的访问 key。用户在 Obsidian 插件中填写地址与访问 key，再创建库并设置加密密码。无需 `server.json`、`sync-key.txt` 或命令行接入窗口。

## 运维

持久状态是 PostgreSQL 与 `data/objects/`；凭据在 `secrets/`。数据库与对象必须在同一停止写入边界备份，恢复后保留客户端连续性校验。联合生产还原尚未验收。

证书续期后更新 `secrets/tls/` 中的副本并重启 server，再验证 HTTPS。更换管理员密码文件后需重启服务，原管理会话失效。更改管理密码不更改用户访问 key 或库加密密码。

不要整体清理其他项目容器或 volume，不直接替换 PostgreSQL 主版本标签。生产部署需单独授权；这些文件是可复用模板。
