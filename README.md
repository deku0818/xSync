# xSync

Sync an Obsidian vault between your own devices using a self-hosted server and end-to-end encryption. Overlapping edits remain available for explicit conflict review; xSync never chooses a winner by timestamp, upload order, or device priority.

[Install from the Obsidian Community directory](https://community.obsidian.md/plugins/xsync) · [Set up your server](docs/DEPLOYMENT.md) · [Installation and device enrollment](docs/SETUP.md)

Free and open source. Bring your own HTTPS server; no hosted service is included. The current interface is in Chinese.

## What you can do

- Sync notes, attachments, and shareable configuration with end-to-end encryption. Credentials, workspace layouts, and the core-plugin enable list stay local.
- Compare conflicting edits side by side, keep both versions, select a version, merge text manually, or postpone the decision while other files continue syncing.
- Set independent file-size, folder, extension, and regular-expression exclusions on each device. View other devices' rule snapshots without applying them locally.
- Pause and resume without re-entering your saved key. Persistent queues recover interrupted work and automatically catch up when the app returns to the foreground.

## Quick start

1. Follow [server setup](docs/DEPLOYMENT.md). Generate the vault's random sync key on your own computer with `npm run server:init -- --out .local/xsync-owner`. Copy only `server.json` to the server; keep `sync-key.txt` private and backed up separately.
2. Install **xSync** from Obsidian's **Settings → Community plugins → Browse**, or open the [community listing](https://community.obsidian.md/plugins/xsync) and choose **Add to Obsidian**. Enable the plugin. For manual installation, use the files from [GitHub Releases](https://github.com/deku0818/xSync/releases) under `<configuration directory>/plugins/xsync/`.
3. Enter a device name, your HTTPS server address, and the sync key. Select **Save and test**. The first device can enroll; an administrator must temporarily open enrollment for subsequent devices.

Daily controls are pause and resume. A saved key can be reused by leaving the password field empty. See [installation, enrollment, and revocation](docs/SETUP.md) for details.

## Platforms and current limits

Version 0.1.2 is an initial release for independent test vaults. The target platforms are macOS and iOS, with a minimum host version of 1.14.4. Android secure storage is not implemented, and Windows/Linux have not completed physical-device validation. iOS secure storage uses an internal native host bridge and needs validation for each supported host version.

Foreground sync and reconciliation after returning from the background are supported; continuous locked-screen or background execution is not guaranteed. Source files are still read as whole files, even though transfers are chunked. New-device enrollment and protected credential changes still need fresh Mac/iPhone installation tests. Coordinated database/object backup restoration, key migration, and a production security review remain unfinished.

For context on automated scan findings and release provenance, see [Review notes](docs/REVIEW-NOTES.md).

## Network and privacy

The plugin connects to the self-hosted server you configure. It transfers encrypted contents, paths and configuration snapshots, plus file identities, sizes and synchronization metadata. The server can see device names and credential hashes, but does not receive the vault sync key or content-decryption keys. Device sessions and authorization tokens are protected by the operating system; there is no plaintext storage fallback.

There is no analytics, advertising, or plugin self-updater. Credentials, device identity, workspace layout, the core-plugin enable list, and xSync's own files stay local. Unknown secret fields in other plugins' settings may need explicit exclusion.

## 中文简介

个人多设备 Obsidian 同步插件与自建服务，目标是电脑与手机间的端到端加密整库同步。重叠修改展示差异，由用户明确选择版本、保留双方或手动合并。

**当前版本为 0.1.2，插件 ID 为 `xsync`，已发布到 [Obsidian 社区目录](https://community.obsidian.md/plugins/xsync)。** 免费开源，需要自己的 HTTPS 同步服务器，当前界面为中文。已支持普通库初始化、设备接入/撤销和标准发布包；版本文件见 [Releases](https://github.com/deku0818/xSync/releases)。新接入流程仍需 Mac/iPhone 真机复验，联合备份还原与生产安全验收尚未完成，请先在独立测试库验证。

## 当前实现

- TypeScript 插件、IndexedDB/Dexie 本地状态，Go HTTP/WebSocket 服务、Docker PostgreSQL 元数据和不可变密文对象。
- 所有者本机生成随机同步密钥与公开服务初始化包；无需测试标记或预置设备令牌。首次设备证明持有密钥后接入，后续设备需服务端临时开放窗口；支持本机管理命令撤销和令牌恢复。
- 名称、地址、同步密钥“保存并测试”后自动连接；Mac 使用 Electron safeStorage，已适配的 iOS 宿主使用原生 Keychain。暂停/恢复保留配置与密钥，重开后仍暂停。
- 已保存密钥显示固定圆点占位，实际输入值为空；留空复用，新密钥验证成功才替换。
- 普通文件和可共享配置；本机独立的 1–100 MB、目录、后缀和 RE2 正则规则。凭据、身份、布局、队列/暂存、本插件及 core-plugins.json 固定排除。
- 唯一客户端名称、加密配置快照、排除树、冲突审阅及短文本手动合并；有新版本时更新比较并保留草稿，无默认赢家。
- 持久化队列、应用 journal、幂等回执、日志过期快照恢复及前台自动补齐。回到前台补齐不等于持续后台同步。
- 工作区尚未发布：本机已完成数据清理，以及带上传/下载保护的服务端密文、日志和快照清理；保留当前版本、未解决冲突和因果关系，不提供历史版本或回收站。新插件与服务端须配套使用，已发布插件不能与本轮新服务端混用，见[内容生命周期](docs/DECISIONS.md#服务端内容生命周期第二步已实现尚未发布)。

工作区另已实现第三步 3A/3B/3C：基线凭据、请求确认、修订/位置/本机缓存压缩、密文哈希对象身份回收及旧队列迁移，尚未发布；快照只携带当前版本头和凭据。旧格式对象摘要、旧接受索引/回执和文件删除身份仍保留，不提供历史版本或回收站，见[决策](docs/DECISIONS.md)。 本轮另补设备连续性保护、旧数据库准确基线补证和数据库丢失后的迁移状态恢复；同 epoch 旧备份即使序号追平也不能自动覆盖已有连续性证据的本机内容，插件与服务端须配套升级。

大附件源文件仍整读，分块传输不等于源文件流式读取。未知第三方配置中的私密字段仍需适配；iOS 内部桥接兼容、资源和迁移边界需继续验证。详细合同见[决策](docs/DECISIONS.md)。

## 安装与自建

先阅读[安装与接入](docs/SETUP.md)和[服务部署](docs/DEPLOYMENT.md)。`npm run server:init -- --out .local/xsync-owner` 在所有者电脑生成初始化文件，只把 `server.json` 送到服务器，`sync-key.txt` 留在自己的设备与离线备份中。

在 Obsidian 的“设置 → 第三方插件 → 浏览”中搜索 **xSync**，或从[社区展示页](https://community.obsidian.md/plugins/xsync)点击 **Add to Obsidian**，安装并启用。手动安装可使用 GitHub Release 文件；开发构建运行 `npm run package:plugin`，将生成的 `xsync/` 文件夹放到独立测试库的 `<配置目录>/plugins/`。填写名称、HTTPS 地址、同步密钥，保存并测试后前台自动同步。后续新增设备需管理者临时开放接入。最低宿主版本暂设为 1.14.4；Android 尚无安全存储适配，Windows/Linux 未完成真机验收。

插件会连接用户配置的自建服务，上传文件/路径/配置的密文、文件身份、长度和同步版本元数据；服务端可见设备名称与授权摘要。没有分析统计、广告或插件自动更新器。暂停会保留本机配置；凭据、身份、布局、核心插件启用状态及 xSync/旧开发插件自身固定排除。其他第三方配置中的未知秘密字段仍可能未被识别，应使用本机排除规则。网络和本机存储边界见[安装说明](docs/SETUP.md)。

## 开发

Node >=22.12，依赖由 package-lock.json 固定：

```sh
npm ci
npm run check
```

check 执行类型检查、默认自动测试和两个插件构建，生成物位于 plugin/dist/ 与 tests/probe/dist/。同步插件的唯一 manifest 位于根目录，探针独立。默认测试不运行需后端或原生浏览器的集成。

后端验证另需 Go >=1.27、运行中的 Docker/Compose v2：

```sh
npm run desktop:setup
npm run test:desktop
npm run desktop:start
```

Go 依次取 OBSIDIAN_SYNC_GO、项目本地编译器、PATH 中的 go。PostgreSQL 只使用本项目 Docker 资源，不需要宿主 PG。test:desktop 包含数据库/race、双客户端、恢复和独立 Chrome 原生 IndexedDB 强杀套件；缺少浏览器会报告未执行，可用 OBSIDIAN_SYNC_CHROME 指定路径。已有服务运行时不要重复启动。

生成的本地测试库、凭据、数据库、报告和构建产物不纳入 Git，自动化测试源码与 HTML 保留。每轮清理后需重新 setup；不得将旧客户端当成新服务的同一身份。开发与清理方式见[测试流程](docs/testing/DEVELOPMENT.md)。

## 文档

- [安装](docs/SETUP.md)、[自建服务](docs/DEPLOYMENT.md)、[发布准备](docs/RELEASING.md)。
- [更新记录](CHANGELOG.md)、[交接](docs/HANDOFF.md)、[文档索引](docs/README.md)、[贡献指南](CONTRIBUTING.md)。
- [架构](design/architecture.html)、[连接与规则](design/connection-settings.html)、[冲突处理](design/sync-conflicts.html)：普通本地 HTML，保留为设计演示，不连接真实服务。
- [协议模型](protocol/MODEL.md)、[电脑开发](docs/testing/desktop.md)、[移动验证](docs/testing/mobile-probe.md)。

HTML 可直接打开，也可用 make preview 在本机预览。实现按 plugin/、server/、protocol/、tests/ 分工，docs/ 保存长期说明；截图、日志、JSON 结果与临时文件只放忽略目录，不提交。

## 许可

项目采用 [MIT License](LICENSE)。官方插件模板与依赖保留相应许可，见 [模板来源](plugin/TEMPLATE.md) 和 plugin/licenses/。
