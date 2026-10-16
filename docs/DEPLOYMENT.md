# 自建 xSync 服务

本文是可复用的配置说明；实际部署状态保存在管理员私有运维记录中。服务运行不等于生产安全或真机同步验收。服务端单进程管理一个同步库；多实例事件通知和生产容量尚未验收。设备接入见[安装说明](SETUP.md)。

## 数据库版本与部署入口

| 数据库 | 当前支持 | 部署说明 |
| --- | --- | --- |
| PostgreSQL | 已实现；生产 Compose 使用 `17.11-bookworm`，开发基线 `17.11-alpine` | [完整 Compose 与 Nginx 部署](deployment/postgres.md) |
| SQLite | 尚未实现，无可运行镜像/Compose 版本 | [范围与后续要求](deployment/sqlite.md) |

已有 Docker Nginx 时，优先使用 [server/deploy/postgres/docker-compose.yaml](../server/deploy/postgres/docker-compose.yaml)：包含服务端和 PG，后端 TLS、独立数据库网络、持久目录及日志轮转；示例目录为 `/srv/xsync`，域名为 `sync.example.com`。下文保留源码进程/宿主代理的另一种配置方式。`server/compose.yaml` 只启动数据库；不要将两套同名 `xsync-server` Compose 项目同时运行。

## 数据与进程

需要 Go >=1.27、Docker/Compose v2、HTTPS 域名与有效证书。PostgreSQL 只在 Docker 中运行。仓库提供 `server/compose.yaml`，使用专属 `xsync-server` 项目、volume，数据库只绑定服务器 loopback 的 `55439` 端口；开发环境是另一个项目和 `55438` 端口，不混用。

先在自己的电脑生成初始化材料，仅将 `server.json` 送到服务器的 `/srv/xsync/server.json`。不要在托管服务器生成或存放 `sync-key.txt`。在服务器用私有文件保存随机数据库密码，例如：

```sh
umask 077
mkdir -p /srv/xsync
openssl rand -hex 32 > /srv/xsync/postgres-password.txt
export XSYNC_POSTGRES_SECRET_FILE=/srv/xsync/postgres-password.txt
docker compose -f server/compose.yaml up -d --wait
```

将密码以 URL 编码形式填入服务进程的私有环境文件，配置 `XSYNC_DATABASE_URL=postgres://xsync:<password>@127.0.0.1:55439/xsync?sslmode=disable`。上面的十六进制密码不需要额外编码。不要把真实密码写入 README、命令历史或 Git；服务与本机管理命令都从相同的进程环境读取。PG 端口不对公网开放。

在 `server.json` 中配置绝对 `objectDir`，例如 `/srv/xsync/objects`。它保存不可变密文对象，必须是持久磁盘，与数据库一起备份；不能只备份其中一项。不要随意改变 vault ID、epoch、密钥包或验证公钥；服务启动会核对已有数据库身份并拒绝不一致配置。

从仓库根目录构建：

```sh
mkdir -p dist
cd server
go build -o ../dist/xsync-server ./cmd/obsidiansync
```

## 使用服务端镜像

服务端镜像构建/上传流程和 Docker Hub 配置见[发布说明](RELEASING.md#服务端-docker-hub-镜像)。[ycw0818/xsync-server:0.1.1](https://hub.docker.com/r/ycw0818/xsync-server/tags?name=0.1.1) 已发布，支持 Linux amd64/arm64；此次手动补发不生成 latest，请使用明确版本或 digest。本地也可从根目录执行 `docker build -f server/Dockerfile -t xsync-server:local .`，不需要上传。根目录 `.dockerignore` 只允许服务端 Go/SQL 源码、模块锁定文件、Dockerfile 和项目许可进入构建上下文。

镜像使用非 root 用户 `65532:65532`，默认执行 `xsync-server --config /config/server.json`。配置与数据在运行时挂载，容器内对象路径应设置为 `/data/objects`。下面是 **Linux Docker Engine** 配合宿主 HTTPS 代理和前述 Docker PG 的运行方式；使用 host 网络，使原有 loopback HTTP/TLS 约束和 `127.0.0.1:55439` 数据库地址保持有效。此示例不适用于默认网络配置的 Docker Desktop，也不能把它改成 bridge 加 `-p` 后仍期待容器 loopback 可访问。

1. 将所有者电脑生成的 `server.json` 放到 `/srv/xsync/server.json`，设 `listen` 为 `127.0.0.1:8873`、`objectDir` 为 `/data/objects`，其余身份/密钥包字段保持原值。
2. 创建私有 `/srv/xsync/server.env`，只配置 `XSYNC_DATABASE_URL=postgres://xsync:<password>@127.0.0.1:55439/xsync?sslmode=disable`，文件权限设为 `0600`。密码使用前面生成的十六进制值；同步密钥不要复制到服务器。
3. 为容器用户准备对象目录及配置读取权限，再运行已发布的确定版本：

```sh
sudo mkdir -p /srv/xsync/objects
sudo chown 65532:65532 /srv/xsync/objects /srv/xsync/server.json
sudo chmod 700 /srv/xsync/objects
sudo chmod 400 /srv/xsync/server.json
docker run -d --name xsync-server --restart unless-stopped \
  --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --env-file /srv/xsync/server.env \
  --mount type=bind,src=/srv/xsync/server.json,dst=/config/server.json,readonly \
  --mount type=bind,src=/srv/xsync/objects,dst=/data/objects \
  ycw0818/xsync-server:0.1.1
```

镜像标签以实际成功上传的版本为准，也可改用固定 digest。PostgreSQL 仍由 `server/compose.yaml` 独立运行，不包含在镜像内。对象目录和 PG volume 均需持久化与联合备份；删除/重建容器不能删除它们。宿主 HTTPS 代理仍须按下一节转发 WebSocket。若选择服务直接提供 TLS，需额外挂载可由 UID 65532 读取的证书与私钥，并显式传入 `--config`、`--tls-cert`、`--tls-key`；不放宽监听校验。

本机管理命令通过容器内同一个二进制执行，例如：

```sh
docker exec xsync-server /usr/local/bin/xsync-server --config /config/server.json --list-devices
docker exec xsync-server /usr/local/bin/xsync-server --config /config/server.json --enroll-for 10m
```

容器没有 shell，管理命令继承创建容器时的环境。运行说明尚未代替实际生产部署、备份还原或真机验收。

## HTTPS

可使用已有反向代理：保持 `listen` 为 `127.0.0.1:8873`，服务只接受本机 HTTP，由代理提供有效的公网 HTTPS。代理必须转发 `/events` WebSocket 升级，以及其他原样路径；不得记录 Authorization 头或请求体。设置合适的请求速率、连接数和磁盘配额，单个密文对象请求上限为 16 MiB。客户端地址填 `https://sync.example.com`，不带路径、用户信息或查询参数。

也可直接让服务提供 TLS：把 `listen` 设置为 `0.0.0.0:8873` 或明确的 IP，运行：

```sh
./dist/xsync-server --config /srv/xsync/server.json \
  --tls-cert /path/to/fullchain.pem --tls-key /path/to/privkey.pem
```

非 loopback 正式监听必须同时提供证书和私钥。自签证书不应通过跳过校验解决；手机和电脑需要信任证书链。证书续期后需按进程管理方式重新加载/重启服务。公网 HTTP 不开放，`--dev-lan-listen` 仅用于隔离假库测试，不能作为正式部署替代。

使用服务管理器配置工作目录、非特权用户、重启策略、私有环境文件、持久目录与日志轮转。服务需要数据库 schema 权限和对象目录读写权限；公开静态文件服务不得暴露配置、对象目录或密钥文件。CLI 管理命令使用相同配置和环境，不开放 HTTP 管理口。

## 接入、撤销与恢复

首次接入需要客户端持有同步密钥。第一台成功后默认关闭接入，用 `--enroll-for 10m` 临时开放其他设备；用 `--enroll-for 0` 提前关闭。`--list-devices` 查看 ID，`--revoke-device` 撤销访问。挑战有效 90 秒，未完成挑战最多 128 个；设备记录最多 256 个，撤销记录也计入，避免删除历史身份。成功回执保留至该设备下一次令牌更换，重试不会生成第二个身份。

网络断开时客户端保留队列；服务事件只是提示，HTTP 拉取负责补齐。单实例重启后的设备授权、撤销和数据依赖 PostgreSQL 持久化。对象内容不可变，不能手动替换成其他密文。

备份必须联合保存数据库、对象和相匹配的公开初始化包；同步密钥另由所有者离线保存。恢复旧备份后客户端可能拒绝回退/epoch 不一致状态，这是保护机制，不能通过重置客户端游标绕过。联合备份的实际还原流程尚未验收，当前没有自动修复或迁移工具。源码包可用于独立环境预发布验证，不应把这些未验收项当成生产保障。

不运行 `docker system prune`，不删除其他项目容器/volume。生产数据的 `down -v` 会删除数据库；开发清理只操作 `server/compose.dev.yaml`。
