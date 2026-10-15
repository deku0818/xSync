# ObsidianSync

个人多设备 Obsidian 同步插件与自建服务，目标是电脑与手机间的端到端加密整库同步。重叠修改展示差异，由用户明确选择版本、保留双方或手动合并。

**当前为 0.0.10 实验开发版，仅允许生成的独立测试库。** 尚未实现普通库初始化、正式设备接入/撤销、联合备份还原和完整生产安全验收，不用于真实主库。

## 当前实现

- TypeScript 插件、IndexedDB/Dexie 本地状态，Go HTTP/WebSocket 服务、Docker PostgreSQL 元数据和不可变密文对象。
- 名称、地址、同步密钥“保存并测试”后自动连接；Mac 使用 Electron safeStorage，已适配的 iOS 宿主使用原生 Keychain。暂停/恢复保留配置与密钥，重开后仍暂停。
- 已保存密钥显示固定圆点占位，实际输入值为空；留空复用，新密钥验证成功才替换。
- 普通文件和可共享配置；本机独立的 1–100 MB、目录、后缀和 RE2 正则规则。凭据、身份、布局、队列/暂存、本插件及 core-plugins.json 固定排除。
- 唯一客户端名称、加密配置快照、排除树、冲突审阅及短文本手动合并；有新版本时更新比较并保留草稿，无默认赢家。
- 持久化队列、应用 journal、幂等回执、日志过期快照恢复及前台自动补齐。回到前台补齐不等于持续后台同步。

大附件源文件仍整读，分块传输不等于源文件流式读取。未知第三方配置中的私密字段仍需适配；iOS 内部桥接兼容、资源和迁移边界需继续验证。详细合同见[决策](docs/DECISIONS.md)。

## 开发

Node >=22.12，依赖由 package-lock.json 固定：

```sh
npm ci
npm run check
```

check 执行类型检查、默认自动测试和两个插件构建，生成物位于 plugin/dist/ 与 tests/probe/dist/。默认测试不运行需后端或原生浏览器的集成。

后端验证另需 Go >=1.27、运行中的 Docker/Compose v2：

```sh
npm run desktop:setup
npm run test:desktop
npm run desktop:start
```

Go 依次取 OBSIDIAN_SYNC_GO、项目本地编译器、PATH 中的 go。PostgreSQL 只使用本项目 Docker 资源，不需要宿主 PG。test:desktop 包含数据库/race、双客户端、恢复和独立 Chrome 原生 IndexedDB 强杀套件；缺少浏览器会报告未执行，可用 OBSIDIAN_SYNC_CHROME 指定路径。已有服务运行时不要重复启动。

本地测试库、凭据、数据库、旧验收报告和构建产物已清理，自动化测试源码与 HTML 保留。再次测试需重新 setup；不得将旧客户端当成新服务的同一身份。开发与清理方式见[测试流程](docs/testing/DEVELOPMENT.md)。

## 文档

- [更新记录](CHANGELOG.md)、[交接](docs/HANDOFF.md)、[文档索引](docs/README.md)、[贡献指南](CONTRIBUTING.md)。
- [架构](design/architecture.html)、[连接与规则](design/connection-settings.html)、[冲突处理](design/sync-conflicts.html)：普通本地 HTML，保留为设计演示，不连接真实服务。
- [协议模型](protocol/MODEL.md)、[电脑开发](docs/testing/desktop.md)、[移动验证](docs/testing/mobile-probe.md)。

HTML 可直接打开，也可用 make preview 在本机预览。实现按 plugin/、server/、protocol/、tests/ 分工，docs/ 保存长期说明；截图、日志、JSON 结果与临时文件只放忽略目录，不提交。

## 许可

项目采用 [MIT License](LICENSE)。官方插件模板与依赖保留相应许可，见 [模板来源](plugin/TEMPLATE.md) 和 plugin/licenses/。源码提交不代表生产发布。
