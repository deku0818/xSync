# 部署 xSync

准备一台安装了 Docker Compose、OpenSSL 的 Linux 服务器。xSync 服务本体可以通过 HTTP 运行，不需要先配置域名或证书。

## 1. 启动服务

新建目录，在其中生成密码文件：

```bash
mkdir -p xsync && cd xsync
umask 077
test -f .env || printf 'POSTGRES_PASSWORD=%s\nXSYNC_ADMIN_PASSWORD=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" > .env
```

将以下内容保存为 `compose.yaml`：

```yaml
name: xsync
services:
  postgres:
    image: postgres:17.11-bookworm
    restart: unless-stopped
    environment:
      POSTGRES_USER: xsync
      POSTGRES_DB: xsync
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
    ports:
      - "127.0.0.1:55439:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U xsync -d xsync"]
      interval: 5s
      timeout: 3s
      retries: 30
  server:
    image: ycw0818/xsync-server:latest
    command: []
    network_mode: host
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      XSYNC_DATABASE_URL: postgres://xsync:${POSTGRES_PASSWORD}@127.0.0.1:55439/xsync?sslmode=disable
      XSYNC_ADMIN_PASSWORD: ${XSYNC_ADMIN_PASSWORD:?}
      XSYNC_LISTEN: 127.0.0.1:8873
      XSYNC_TRUSTED_PROXIES: 127.0.0.1/32,::1/128
    volumes:
      - sync-data:/data
volumes:
  postgres-data:
  sync-data:
```

启动：

```bash
docker compose up -d --wait
```

服务启动后，本机地址为 `http://127.0.0.1:8873`。

手机和远程插件连接使用 HTTPS，可自行用 Nginx 等反向代理到上述 HTTP 地址，开启 WebSocket，上传大小限制至少设为 17 MB。本例的 HTTP 服务仅监听本机回环地址，不直接向公网暴露。

<details>
<summary>HTTPS 反向代理参考（Nginx）</summary>

在域名已有的 HTTPS `server {}` 中添加。此示例的 Nginx 运行在宿主机上；若也运行在 Docker 中，需使用 host 网络：

```nginx
client_max_body_size 17m;
location / {
    proxy_pass http://127.0.0.1:8873;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

</details>

## 2. 创建用户，取得 key

打开服务的 `/admin/` 页面（本机为 `http://127.0.0.1:8873/admin/`，配置反代后为 `https://你的域名/admin/`），用 `.env` 中的 `XSYNC_ADMIN_PASSWORD` 登录。点击“创建用户”，填写名称并保存访问 key；key 只展示一次。

可以为自己和朋友分别创建用户，每人使用独立的访问 key 与知识库。后台可以刷新 key、停用或删除用户。库加密密码由用户在插件中设置，服务器无法解密知识库内容。

## 3. 连接 Obsidian

按[插件接入说明](SETUP.md)安装 xSync，填写服务地址与访问 key，即可创建或加入同步库。

## 常用操作

- 查看日志：`docker compose logs --tail 100 server`
- 更新服务：`docker compose pull && docker compose up -d`
- 备份：保留 `.env`，停止服务后同时备份 `postgres-data`、`sync-data` 两个数据卷。用户另行保存库加密密码。
