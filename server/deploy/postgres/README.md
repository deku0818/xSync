# xSync PostgreSQL 部署入口

本目录文件可复制到部署机器的 `/srv/xsync`。完整说明位于仓库 `docs/deployment/postgres.md`；SQLite 尚未支持。

- `docker-compose.yaml`：xSync 0.1.1（固定 digest）与 PostgreSQL 17.11-bookworm。
- `.env.example`：复制为 `.env`，只填写镜像和已有 Nginx Docker 网络。
- `configure.py`：读取所有者电脑生成的初始化包，为全新 Linux 部署设置随机数据库密码、TLS 副本和文件权限；已有 secrets/data 时拒绝重新初始化。

新部署还需要 `server-init.json` 和有效 TLS 证书。同步密钥只在所有者设备保留，不能上传。已有部署不要再次运行初始化脚本。

运行与检查：

```sh
cd /srv/xsync
docker compose config --quiet
docker compose up -d --wait --wait-timeout 180
docker compose ps
docker compose logs --tail 100 server
```

示例公网地址：`https://sync.example.com`。服务没有网页管理界面，公开 `/onboarding` 用于设备接入；未授权 `/handshake` 返回 401。

```sh
docker compose exec -T server /usr/local/bin/xsync-server --config /config/server.json --list-devices
docker compose exec -T server /usr/local/bin/xsync-server --config /config/server.json --enroll-for 10m
docker compose exec -T server /usr/local/bin/xsync-server --config /config/server.json --enroll-for 0
```

示例 Nginx 容器为 `nginx-proxy`，站点配置为 `/srv/nginx/conf.d/xsync.conf`。修改后先运行 `docker exec nginx-proxy nginx -t`，通过后再 `nginx -s reload`。旧配置备份位于 `backups/nginx/`。

持久状态是 `data/postgres/`、`data/objects/` 与 `secrets/`。不要删除、重新初始化或提交这些目录，也不要单独恢复其中一项。更新服务只更换镜像，保留身份和数据；PostgreSQL 主版本不能直接换标签。

服务端 TLS 使用 `secrets/tls/` 中的副本。原证书续期后还需同步副本并重启 server，再检查 HTTPS。未配置自动副本刷新时必须人工完成；完整步骤在部署文档的“证书续期”一节。
