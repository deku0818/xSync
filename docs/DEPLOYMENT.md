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

## 工作区新内容协议与自动清理（尚未发布）

本轮源码新增 `content-leases-v1`，须配套使用新插件和新服务端；已发布 0.1.2 插件不支持新服务端的内容保护要求。HTTP 同步请求强制协商，旧客户端返回 `CLIENT_UPGRADE_REQUIRED`。升级不重写已有 outbox 请求或重置库/epoch；不可把旧二进制直接回退到新 schema/已回收的对象目录。

服务私有 `server.json` 可选 `cleanupMode`：`on`（默认）、`dry-run`、`off`。默认每分钟维护，5 分钟可续期内容保护、1 小时无依赖宽限；日志最多 7 天、10,000 个提交组及 64 MiB。`dry-run` 仅报告密文候选，不删除日志/快照或密文；`off` 停止自动维护，仍要求新协议。完整规则见 [决策](DECISIONS.md)。

本机管理员可执行 `obsidiansync --config <private-config> --cleanup-once --cleanup-dry-run` 先检查，再以 `--cleanup-once` 执行一轮；配置为 `dry-run` 时手动命令也保持只检查，实际删除前须显式将配置切回 `on`。沿用原数据库环境与私有配置，维护命令不启动监听。密文回收不清理修订、删除身份或幂等回执，不提供历史或回收站入口。备份继续停止整个 server 进程，等待维护退出后联合保存 PG、对象与配置，不单独复制活动对象目录。普通部署无需使用仅供隔离测试的维护故障注入参数。

## 工作区 3A 基线认证材料（尚未发布）

3A 新客户端要求 `metadata-anchors-v1`，3B 进一步要求 `compact-heads-v1` 并启用修订/位置/回执压缩。PG 自动保存独立的基线 HMAC 认证密钥和已初始化标记，所有实例必须共享同一数据库材料；不得删表后靠重启重建。它不是笔记解密密钥，但必须随私有 PG 联合备份保存。缺失/回退时拒绝自动继续，不通过重置请求计数或设备身份绕过。

本机 IndexedDB schema v5 保留原队列并增加请求坐标、基线凭据和完成确认账本。复制同一设备身份到两个独立活动数据库不受支持；请求计数回退会要求恢复核对。3B/3C 已扩展修订/位置/新格式对象身份回收，旧格式摘要和旧接受索引仍保留，具体迁移边界见后文。

## 工作区 3B 迁移与压缩（尚未发布）

新服务默认首次打开 PG 时建立旧接受索引和检查点，随后按依赖维护修订/位置，不改 vault epoch 或重置序号。旧提交入口仅返回仍保留的原成功回执；新提交走带请求序号的 metadata 信封。所有同步入口要求配套客户端的 `X-Sync-Compaction`。部署前仍需停服联合备份和独立假库升级验收；本轮没有实际部署或发布。

若需要在首次切换前暂缓，可在私有 server.json 设置 `metadataMode: "full"`，保留完整图路径；默认或 `"compact"` 切换后不可再改回 full，启动会拒绝降级。`cleanupMode` 只控制维护：`off` 停止自动清理，`dry-run` 不删除修订/位置/日志/快照/密文，但不阻止首次协议迁移或正常提交确认。不能依赖这两个维护开关回退协议。本轮程序的 full 实例会检测外部切换并拒绝同步；这不保护仍运行的旧版二进制，升级时必须停止全部旧服务实例，不并行混用。

旧插件不能继续同步，需要配套新构建。新插件首次连接按原 outbox 登记一次不可变旧队列包，响应丢失重试同一包；超过 4096 项或 32 MiB 会保留队列并拒绝，需单独规划迁移，不能清库绕过。登记外旧备份/计数回退要求核对，不自动将当前文件重新当作旧队列内容。联合 PG 备份须包含旧接受索引、旧回执、登记状态、请求流/确认区间及签发密钥，不能只还原 heads/revisions 表。

正常编辑不会继续增长永久修订/位置身份索引；当前头、未解决冲突、保留日志和活动快照受保护。3C 已回收新格式对象身份，旧格式随机摘要仍保留；手机、大库和联合备份实际还原仍需独立验证。

## 工作区 3C 密文对象与存储标识（尚未发布）

所有同步端点要求 `X-Sync-Objects: addressed-objects-v1`，包括 `metadataMode=full`；必须停服配套升级插件和服务端，不能让旧二进制并行写同一数据库/对象目录。新对象公开 ID 为 `c_<SHA256(密文字节)>`，实际磁盘文件是 `<c_ID>.s<随机 storage_token>`；旧 ID / `.gN` 文件仍兼容。不要按公开 ID 重命名、筛选或只复制对象文件的一部分。

联合 PG 备份必须保留 objects、upload_attempts、object_gc_jobs、lease_objects 中的物理标识，以及旧对象一次登记状态。与完整对象目录来自同一停服边界，不能只恢复身份主表或省略临时/删除任务来“精简”备份。新格式身份在内容删除完成后可以不存在；旧格式随机身份摘要仍是准确重试证据，不能手动清空 deleted 旧行。

本机 schema v7 在 3B 登记之外，单独登记升级前旧对象 outbox；包上限仍为 4096 请求/32 MiB，失败保留原数据。`cleanupMode=off/dry-run` 不阻止协议协商、登记或普通提交确认，不能作为降级开关。持续正常编辑不再追加永久新对象身份，但旧摘要、旧索引、墓碑/撤销身份和未完成恢复证据仍可能长期保留。iPhone、大库资源、备份实际还原与生产安全审查仍未完成，本轮没有实际部署。


## 工作区恢复连续性（尚未发布）

配套插件/服务端新增强制能力 `device-continuity-v1`，旧客户端拒绝同步。PG 每设备一个连续性标记，本机 schema v8 保存确认/pending/升级补证状态，不重置既有队列或库身份。全局序号追平不能证明旧联合备份安全；连续性不匹配时保留本机内容并停止自动应用，需单独核对恢复。不能删除连续性表、清空本机标记、重置计数/游标或改 epoch 来绕过。

停服联合备份必须包含 `device_continuity` 以及前述完整元数据、对象目录和协议密钥材料。旧客户端首次升级会认证原展示/待处理基线；认证失败保持待核对。已完成非空旧迁移后本机数据库丢失，空队列可读取服务端完成状态继续文件核对，不能借此登记新的未知旧队列。同一设备身份不能复制为两个独立活动数据库。

隔离测试覆盖实际 PG/对象还原、序号追平及客户端阻断，尚不代表生产备份流程、恢复工具或真机验收完成。同步范围仍只有当前文件与未解决冲突，没有历史版本或回收站。
