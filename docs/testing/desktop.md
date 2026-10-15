# 电脑开发环境

当前本机生成的测试库、配置、密文对象和专属 Docker 数据已清理；下列步骤用于重新创建独立假库，不代表这些资源现在存在。

## 准备

Node >=22.12、Go >=1.27、运行中的 Docker/Compose v2。Go 依次取 OBSIDIAN_SYNC_GO、.local/toolchains/go/bin/go、PATH 中的 go。PostgreSQL 不在宿主安装或运行。

```sh
npm ci
npm run desktop:setup
npm run test:desktop
npm run desktop:start
```

setup 生成测试凭据、启动专属 Docker 数据库、构建插件/服务并准备 A/B 库；不启动 Obsidian 或 HTTP 服务。start 前台运行开发 HTTP，已有监听时不要重复启动。

在 Obsidian 打开 tests/desktop/vaults/ObsidianSync-电脑A 与 ObsidianSync-电脑B，仅使用生成的假数据。重复 setup 保留已有身份/笔记并更新插件；删除整个环境后再次 setup 会创建新身份，不能与旧客户端混用。

## 资源

- Compose：server/compose.dev.yaml，项目 obsidiansync-dev。
- PostgreSQL：127.0.0.1:55438，volume obsidiansync-dev_postgres-data。
- 默认开发 API：127.0.0.1:8873，配置/对象在 .local/desktop/。
- 手机 LAN HTTP 只允许显式测试开关、隔离 schema 和预置的精确私有 origin；普通客户端仍要求 HTTPS。

日常停止数据库用 npm run desktop:stop-db，保留卷；服务前台用 Ctrl+C 停止。彻底丢弃本项目测试数据时才使用：

```sh
docker compose -f server/compose.dev.yaml down --volumes
```

该命令只用于本项目专属资源，不能对其他项目执行 prune。清理后客户端和服务器必须按新环境重新配对，不能只清服务器后让旧客户端继续写入。

## 使用合同

保存并测试验证连接/授权/名称/密钥并由设备安全存储保护材料；已保存输入框为空、圆点为占位。暂停/恢复保留配置与密钥，重开保持暂停。冲突由用户决定准确快照，其他文件继续同步。

desktop:setup 的 A/B 旧协议夹具仍预置独立身份和授权，以保持故障恢复回归可复现。普通新库不需要该夹具，通过挑战签名接入新初始化的服务，见[安装与接入](../SETUP.md)。不能将旧测试服务/身份与新初始化服务混用。自动化入口和验证边界见[测试流程](DEVELOPMENT.md)。
