# ObsidianSync

个人多设备 Obsidian 整库同步插件与自建同步服务，目标是电脑与手机间的端到端加密同步。重叠修改展示差异，由用户明确选择版本、保留双方或手动合并。

**当前为 0.0.6 / Phase 02 实验性桌面开发版，仅用于生成的独立测试库。** 已完成同机 Obsidian A/B 验证；物理双机、Windows/Linux、iPhone/Android、完整恢复与生产安全审查尚未完成。这是独立项目，与 Obsidian 官方同步服务无关。

## 当前实现

- TypeScript 插件、IndexedDB / Dexie 本地状态，Go HTTP / WebSocket 服务、Docker PostgreSQL 元数据与不可变密文对象。
- 填写客户端名称、服务器地址与同步密钥，“保存并测试”后自动连接；当前 Mac 使用系统安全存储保护解锁材料。日常暂停/恢复保留配置，重开后仍暂停。
- 普通文件与可共享 `.obsidian` 配置，单文件可配置 1–100 MB（100 MB = 100,000,000 字节）；文件夹、后缀和 RE2 正则规则按设备独立生效。
- 同 vault 客户端名称唯一，其他客户端的加密配置快照只读查看；真实排除树、同步概览、准确版本差异与短文本手动合并。
- 冲突无默认赢家；暂不处理保留双方，其他文件继续同步。审阅期间出现新版本会清除旧选择并保留草稿。

凭据、身份、布局、队列和暂存固定排除；已识别的 JSON 本机字段保留各设备自己的值，未知第三方私密字段仍需适配。当前需要预置设备授权，尚无通用设备接入/撤销/轮换。大附件源文件仍整读，完整附件/多版本审阅、历史/GC 和联合备份仍待完成。详细能力与边界见 [0.0.6 验收](docs/testing/desktop-v006-2026-10-15.md)。

## 快速开发

Node >=22.12，依赖由 `package-lock.json` 固定：

```sh
npm ci
npm run check
```

`check` 包括类型检查、协议/核心/探针辅助测试和两个插件构建。产物在 `plugin/dist/`，不提交到 Git；探针与同步开发插件相互独立。开发时可用 `npm run test:watch` 或 `npm run dev:plugin`。

服务端与双客户端验证还需要 **Go >=1.27、运行中的 Docker 与 Compose v2**。Go 编译器依次取 `OBSIDIAN_SYNC_GO`、项目本地 `.local/toolchains/go/bin/go`、PATH 中的 `go`；不需要宿主 PostgreSQL：

```sh
npm run desktop:setup
npm run test:desktop
npm run desktop:start
```

`setup` 启动专属 Docker 数据库、生成独立凭据和 A/B 假库；`test:desktop` 使用独立测试 schema；`start` 前台运行开发 HTTP 服务。数据库与 HTTP 只绑定本机，分别使用 55438 和 8873 端口。已有服务运行时不要启动第二份；`npm run desktop:stop-db` 停止数据库并保留卷。

测试库位于 `tests/desktop/vaults/`，配置与对象在 `.local/desktop/`，全部忽略。重复 setup 保留已有笔记与身份、更新测试插件。详细步骤见 [电脑验证](docs/testing/desktop.md) 和 [贡献指南](CONTRIBUTING.md)。

## 验证范围

0.0.6 已通过 59 项默认自动测试、14 项真实 Docker PostgreSQL / 事件 / profile 合同测试（race）和 16 项双客户端集成测试，含准确 100 MB 传输、范围规则、配置字段隔离和过期冲突/合并。自动集成本地状态使用 fake IndexedDB。

当前 Mac 的真实 Obsidian A/B 使用真实 IndexedDB / Vault API，已验证双向自动传输、自动解锁与窗口重开、服务重连、冲突更新、保留双方和手动合并。同机双库不等于物理双机或手机验证，错误注入也不等于完整强杀/断电验收。最新证据见 [验收记录](docs/testing/desktop-v006-2026-10-15.md)；历史版本结果另列于 [文档索引](docs/README.md)。

## 设计与文档

- [交接状态](docs/HANDOFF.md)：当前进度与下一步。
- [需求与决策](docs/DECISIONS.md)：用户确认、技术推荐和未决事项。
- [架构设计](design/architecture.html)、[连接与范围](design/connection-settings.html)、[同步与冲突](design/sync-conflicts.html)：普通本地 HTML；页面交互使用演示数据。
- [协议模型](protocol/MODEL.md)、[测试流程](docs/testing/DEVELOPMENT.md)、[移动探针](docs/testing/mobile-probe.md)。
- [全部文档](docs/README.md)、[项目工作约定](AGENTS.md)、[模板来源与许可](plugin/TEMPLATE.md)。

HTML 可直接用浏览器打开，无外部脚本、字体或样式依赖。也可以运行 `make preview`，打开 [本机设计预览](http://127.0.0.1:8870/architecture.html)；端口可用 `make preview PREVIEW_PORT=8871` 覆盖。

## 仓库结构

```text
plugin/       Obsidian 插件、移动兼容核心、桌面安全存储适配与构建
server/       Go HTTP / PostgreSQL / 密文对象与数据库合同测试
protocol/     实验性协议模型、wire 校验与语义合同
tests/        状态机/属性、核心、探针与双客户端集成测试
design/       自包含 HTML 设计与预览图
docs/         决策、交接、调研与分版本验收证据
.github/      GitHub Actions 开发检查
```

源码与固定依赖可提交；本地凭据、真实笔记、生成假库、数据库和构建产物不进仓库。GitHub Actions 配置执行默认检查及 Docker PostgreSQL/双客户端测试；其远端结果需上传后确认。

## 许可

本项目采用 [MIT License](LICENSE)。上游插件模板的 0BSD 与依赖保留各自许可；相关声明保存在 `plugin/licenses/` 并随构建产物分发。实验 wire / 加密格式尚未冻结为发布兼容合同。
