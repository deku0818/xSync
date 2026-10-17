# 开发与验证流程

## 日常检查

```sh
npm ci
npm run check
```

`check` 执行类型检查、默认测试和探针/同步插件构建。默认跳过需要真实后端或原生浏览器的集成，跳过不能计为通过。文件事件开发可用 `npm run dev:plugin`，持续回归可用 `npm run test:watch`。

## 后端与恢复测试

需要 Go >=1.27、Docker/Compose v2：

```sh
npm run desktop:setup
npm run test:desktop
```

PostgreSQL 使用 `obsidiansync-dev` 专属 Docker 项目。Go 编译器依次取 `OBSIDIAN_SYNC_GO`、`.local/toolchains/go/bin/go`、PATH 中的 `go`。资源位置、手动启动与清理见[电脑开发环境](desktop.md)。

`test:desktop` 运行 Go 合同/race、设备接入、多客户端同步和故障恢复。找到 Chrome/Chromium 后，使用独立 profile 执行真实 IndexedDB/SIGKILL 套件；可用 `OBSIDIAN_SYNC_CHROME` 指定浏览器路径。缺少浏览器时必须记录为未执行，CI 要求浏览器存在。

| 测试入口 | 验证范围 |
| --- | --- |
| `tests/protocol/` | 因果图、幂等、分支、位置 CAS、过期选择及独立图 oracle |
| `tests/desktop/` | 宿主适配、队列、接入、HTTP/PG 多客户端、冲突与恢复 |
| `server/internal/syncstore/` | 数据库事务、回执、快照、压缩、对象回收与设备连续性 |
| `tests/desktop/continuity-recovery.integration.test.ts` | 联合旧备份还原、序号追平和客户端阻断 |
| `tests/desktop/repository-lifecycle.integration.test.ts` | 单文件写入范围、冲突后的 inbox 压缩、拒绝意图退休及回滚、大库分页、附件选择和同轮读取复用 |
| `tests/desktop/plugin-connection.test.ts` | 宿主连接保存与凭据清理；`test:desktop` 另启用真实后端的令牌轮换、回执/配置指针丢失和重开恢复 |
| `tests/desktop/recovery-browser.integration.test.ts` | 原生 IndexedDB 持久化边界与进程强杀 |
| `tests/mobile/` | iOS 保护器的假 native backend 合同 |

所有测试客户端使用独立设备身份，不以两个活动数据库复用同一写入身份。完整备份恢复测试应包含修订、凭据、远端投影和连续性状态，不能只修改游标模拟恢复。

冲突回归需覆盖比较前、上传中及提交响应前继续编辑，确保最新字节保留、旧选择失效、草稿和持久任务可恢复，且其他文件继续同步。宿主 DOM fixture 与 FilePort 模拟不代表真实编辑器验收。

## 真机与探针

按[移动端说明](mobile-probe.md)使用独立假库，验证并发修改、删除/编辑、重命名、过期审阅、暂停保持、回前台补齐、弱网、系统终止、安全存储和资源限制。iOS 后台测试关闭调试连接；JS heap 不替代进程峰值内存证据。

浏览器探针：

```sh
npm run build:probe
python3 -m http.server 8872 --bind 127.0.0.1 --directory tests/probe
```

打开 `http://127.0.0.1:8872/browser-smoke.html`。该探针不读取 Vault，不能作为手机验证。

`tests/desktop/sync-panels.test.ts` 可通过环境变量 `OBSIDIAN_SYNC_UI_PREVIEW_DIR` 向忽略目录输出实际组件的静态预览；预览不代表 Obsidian 安装或真机运行结果。

## 结果与清理

截图、JSON、日志和临时结果放在 `.local/reports/` 等忽略目录，不提交到文档或源码目录。复测前检查已有假库、配置和服务；完整环境清理后重新 setup，已有服务不要重复启动。

模型、fake IndexedDB、HTTP/PG 集成、原生浏览器强杀、物理断电和生产联合备份还原分别说明验证范围。自动测试通过不能替代移动真机、安全存储或生产安全验收。
