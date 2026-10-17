# PostgreSQL Docker Compose 部署

适用于单实例 xSync 0.1.1、自建 Linux Docker Engine、已有 Nginx Docker 容器的环境。SQLite 当前尚未实现。本说明不包含 CouchDB 数据迁移；保留原数据，xSync 创建独立同步库。

## 版本与文件

| 组件 | 使用版本 / 配置 |
| --- | --- |
| xSync 服务端 | `ycw0818/xsync-server:0.1.1`，Compose 默认固定已发布的 index digest |
| PostgreSQL | `postgres:17.11-bookworm`，本部署使用 Debian 变体；不要直接切换主版本 |
| Docker Compose | v2；示例要求 v2.27.1 或兼容的新版本 |
| PostgreSQL 客户端 | 镜像内的 `psql` / `pg_dump`，不安装宿主 PostgreSQL |
| Nginx | 使用已有容器，示例以 1.27.0 配置语法编写 |

仓库文件：

- [docker-compose.yaml](../../server/deploy/postgres/docker-compose.yaml)：服务端和 PostgreSQL 两个服务，无宿主端口映射。
- [.env.example](../../server/deploy/postgres/.env.example)：镜像与已有代理网络名称，没有密码。
- [configure.py](../../server/deploy/postgres/configure.py)：Linux root 下准备首次部署的身份、随机数据库密码、权限和 TLS 副本；已有 secrets 时拒绝覆盖。
- [Nginx 配置](../../server/deploy/nginx/xsync.conf.example)：HTTPS、HTTP 重定向、WebSocket 和后端证书校验。

示例部署目录 `/srv/xsync`，代理网络 `xsync-proxy`，Nginx 容器 `nginx-proxy`。公网地址为 `https://sync.example.com`，DNS 应指向部署服务器。部署前替换域名、服务器地址、证书路径和网络名称；真实环境信息应保存在私有运维记录中。

旧 Linux 内核与 libseccomp 可能与新 Alpine 变体存在系统调用兼容问题，表现为初始化写入 `Operation not permitted`。本模板使用 PostgreSQL 17.11 bookworm 变体，保持默认 seccomp，不使用 privileged。开发环境原有 `17.11-alpine` 配置保持独立。类似旧内核/系统调用问题见 [官方镜像问题记录](https://github.com/nginx/docker-nginx/issues/1059)，具体部署以本机启动检查为准。

```text
/srv/xsync/
  docker-compose.yaml
  .env                         # 公开参数，无密码
  configure.py
  server-init.json              # 所有者电脑生成的初始化包
  secrets/
    postgres-password.txt      # 数据库密码，root 0600
    server.json                # 运行配置，含 DSN，UID 65532 0400
    tls/fullchain.pem          # 服务端 TLS 证书副本
    tls/privkey.pem            # TLS 私钥副本，UID 65532 0400
  data/postgres/               # PostgreSQL 持久化目录
  data/objects/                # 不可变密文对象，UID 65532 0700
  backups/                     # 私有备份；不提交 Git
```

这里的 `secrets/server.json` 包含数据库密码，属于私有运行配置。原始 `server-init.json` 不包含同步密钥；所有者的 `sync-key.txt` 必须另存于自己的电脑和离线备份，不上传服务器。

## 网络

公网 HTTPS → 已有 Nginx → **HTTPS** `xsync-server:8873` → 内部网络 PostgreSQL `postgres:5432`。

服务端连接两个网络：已有代理网络，以及本项目 `internal: true` 的数据库网络。PostgreSQL 只连接数据库网络；两项服务都没有 `ports`。服务端监听 `0.0.0.0:8873` 并启用 TLS，保持程序对非 loopback 监听的安全要求。不要添加开发 LAN 开关。

Nginx 校验后端证书，`proxy_ssl_name` 必须匹配证书域名；配置不使用 `proxy_ssl_verify off`。Docker DNS 每 30 秒重新解析后端地址，重建服务容器无需把 IP 写入配置。[Nginx 官方 WebSocket 说明](https://nginx.org/en/docs/http/websocket.html)解释了为何必须转发 Upgrade / Connection 头。

## 首次部署

1. 在所有者电脑生成独立同步库材料：

```sh
npm ci
npm run server:init -- --out .local/xsync-owner
```

妥善保留 `.local/xsync-owner/sync-key.txt`。不要复用其他服务的身份，也不要重复生成配置去替换已有服务。

2. 创建服务器目录，将上述 Compose、`.env.example`、`configure.py` 和**仅** `server.json` 传入。将 `.env.example` 命名为 `.env`，初始化包命名为 `server-init.json`。例如 SSH 私钥在当前目录时：

```sh
ssh -i ~/.ssh/deploy_key root@SERVER_IP 'install -d -m 700 /srv/xsync'
scp -i ~/.ssh/deploy_key server/deploy/postgres/docker-compose.yaml server/deploy/postgres/configure.py root@SERVER_IP:/srv/xsync/
scp -i ~/.ssh/deploy_key server/deploy/postgres/.env.example root@SERVER_IP:/srv/xsync/.env
scp -i ~/.ssh/deploy_key .local/xsync-owner/server.json root@SERVER_IP:/srv/xsync/server-init.json
```

3. 在服务器确认代理网络、证书域名和有效期。首次初始化：

```sh
cd /srv/xsync
chmod 600 .env server-init.json
docker network inspect xsync-proxy >/dev/null
python3 configure.py --init server-init.json \
  --tls-cert '/etc/letsencrypt/live/sync.example.com/fullchain.pem' \
  --tls-key '/etc/letsencrypt/live/sync.example.com/privkey.pem'
docker compose config --quiet
docker compose pull
docker compose up -d --wait --wait-timeout 180
docker compose ps
```

证书路径需替换为自己机器上的真实文件，始终加引号。初始化脚本验证证书至少还剩七天，并检查证书与私钥匹配。脚本使用系统随机源生成数据库密码，不打印密码/同步密钥。

Compose 按 PostgreSQL `service_healthy` 启动服务端，见 [Docker 启动顺序说明](https://docs.docker.com/compose/how-tos/startup-order/)。`up --wait` 本身只确认服务运行/PG 健康；还需后续 HTTPS 检查。服务端镜像没有 shell，也没有 HTTP healthcheck 子命令。

4. 在覆盖 `/srv/nginx/conf.d/xsync.conf` 前，将旧配置备份到 `/srv/xsync/backups/nginx/`，避免 `.conf` 备份被 Nginx 当成第二份配置加载。安装仓库的 Nginx 示例，先检查，再平滑重载：

```sh
docker exec nginx-proxy nginx -t
docker exec nginx-proxy nginx -s reload
```

若检查失败，恢复备份文件并重新 `nginx -t`；不要重启整个代理栈。旧 CouchDB 的数据库/容器不在此 Compose 项目中，不删除。

## 验证与接入

```sh
curl --fail --silent --show-error https://sync.example.com/onboarding
curl --silent --output /dev/null --write-out '%{http_code}\n' https://sync.example.com/handshake
docker compose exec -T server /usr/local/bin/xsync-server --config /config/server.json --list-devices
```

`/onboarding` 返回协议格式、库身份和密文密钥包；需核对与本地初始化包相同。未授权 `/handshake` 应返回 **401**，不是健康故障。浏览器打开 `/` 也不会显示管理界面。

首次设备填写服务器地址与本机保存的同步密钥；第一台成功后接入关闭。后续设备临时开放窗口：

```sh
docker compose exec -T server /usr/local/bin/xsync-server --config /config/server.json --enroll-for 10m
docker compose exec -T server /usr/local/bin/xsync-server --config /config/server.json --enroll-for 0
```

撤销设备使用同一命令加 `--revoke-device <ID>`。不要通过复制设备身份文件添加设备。服务部署、未授权 WebSocket 入口检查不等于手机/电脑双机同步验收，需在独立测试库验证接入、同步与恢复。

## 运维与更新

```sh
cd /srv/xsync
docker compose ps
docker compose logs --tail 100 server
docker compose logs --tail 100 postgres
```

容器日志限制为每个服务 3 个 10 MB 文件。不要运行 `docker compose config` 的完整输出、打印运行 JSON 或把 secrets 目录送入工单/聊天；需要检查 Compose 时用 `config --quiet`。Compose secrets 是文件挂载，宿主仍需保护文件权限，见 [Docker secrets 文档](https://docs.docker.com/compose/how-tos/use-secrets/)。

更新服务时先备份，再在 `.env` 修改明确镜像版本/digest，执行 `docker compose pull server` 和 `docker compose up -d --no-deps server`，随后重新检查 onboarding 与日志。保留原配置、数据库和对象目录。更换 PostgreSQL 主版本需要独立的导出/恢复或升级流程，不能只换镜像标签。旧程序回退是否兼容未来 schema 需另行核对。

### 证书续期

Nginx 继续使用原证书路径；xSync 使用副本。现有证书更新不会自动更新副本，必须把以下操作接入原有证书续期成功 hook（或人工执行）：

```sh
cd /srv/xsync
install -m 400 -o 65532 -g 65532 \
  '/etc/letsencrypt/live/sync.example.com/fullchain.pem' secrets/tls/fullchain.pem.new
install -m 400 -o 65532 -g 65532 \
  '/etc/letsencrypt/live/sync.example.com/privkey.pem' secrets/tls/privkey.pem.new
openssl x509 -in secrets/tls/fullchain.pem.new -noout -checkend 604800
mv secrets/tls/fullchain.pem.new secrets/tls/fullchain.pem
mv secrets/tls/privkey.pem.new secrets/tls/privkey.pem
docker compose restart server
docker exec nginx-proxy nginx -t
docker exec nginx-proxy nginx -s reload
curl --fail --silent --show-error https://sync.example.com/onboarding >/dev/null
```

执行前核对两份新文件匹配；失败保留旧副本回退。不要运行 `configure.py` 去刷新证书，它只用于首次初始化。

### 备份与恢复边界

数据库与对象必须来自同一个停止写入的边界。建议停止 **server**，保持 PG 运行，用镜像内 `pg_dump -Fc` 备份数据库，连同 `data/objects/`、初始化包、私有运行配置和部署文件一起归档到权限 `0700` 的备份目录；成功后再启动 server。数据库 dump 与归档均按私密材料保护，并复制到独立备份存储；同步密钥由所有者另行离线保存。

联合还原和旧设备重连的完整流程尚未验收。不要向运行中的服务单独恢复数据库或仅替换对象目录，不要通过改 epoch、重置游标或重新初始化绕过回退检查。`docker compose down -v`、删除 data 目录和 `docker system prune` 不属于更新步骤。
