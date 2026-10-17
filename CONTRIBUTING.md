# 开发与贡献

先阅读 [README](README.zh-CN.md) 和 [工作约定](AGENTS.md)。同步行为、加密格式或恢复策略发生变化时，同时更新对应使用说明或[协议说明](protocol/README.md)。

## 本地检查

需要 Node.js >=22.12，依赖以 `package-lock.json` 为准：

```sh
npm ci
npm run check
```

`check` 执行类型检查、默认自动测试与两个插件构建。默认测试不运行需要真实后端或原生浏览器的集成。

服务端与多客户端验证需要 Go >=1.27 和运行中的 Docker/Compose v2：

```sh
npm run desktop:setup
npm run test:desktop
```

Go 编译器依次取 `OBSIDIAN_SYNC_GO`、`.local/toolchains/go/bin/go`、PATH 中的 `go`。PostgreSQL 使用项目专属 Docker 资源，测试使用独立 schema。手动运行服务、清理资源和浏览器配置见[开发流程](docs/testing/DEVELOPMENT.md)与[电脑开发环境](docs/testing/desktop.md)。

## 提交范围

- 提交源代码、固定依赖、测试源码，以及安装、运维、协议和开发说明。
- 决策记录、设计草稿、交接日志、调研、截图和逐轮验收报告保存在仓库外；生成测试结果放在 `.local/` 等忽略目录。
- 不提交构建产物、生成测试库、数据库、真实笔记、密钥、令牌或解锁记录，不用 `git add -f` 绕过忽略规则。
- 提交前运行 `git diff --check` 并检查暂存区。变更说明写清触发场景、行为和验证边界，不将同机双库测试写成真机双设备验证。

CI 执行类型检查、自动测试、构建、标准包校验、Go vet、PostgreSQL 合同/race、设备接入、多客户端和原生浏览器恢复测试。这些检查不能替代 Obsidian 和移动真机验收。发布步骤见[发布流程](docs/RELEASING.md)。

## 许可

采用 [MIT License](LICENSE)。上游模板和依赖保留各自许可，见[模板来源](plugin/TEMPLATE.md)与 `plugin/licenses/`。
