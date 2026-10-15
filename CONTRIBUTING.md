# 开发与贡献

这是实验性开发仓库。先阅读 [README](README.md)、[交接状态](docs/HANDOFF.md)、[决策](docs/DECISIONS.md) 和 [工作约定](AGENTS.md)。同步行为、加密格式或恢复策略的变更必须同时更新文档，区分实现、自动测试和真实设备证据。

## 本地检查

Node >=22.12，依赖以 `package-lock.json` 为准：

```sh
npm ci
npm run check
```

需要验证服务端和双客户端时，准备 Go >=1.27 与运行中的 Docker（包含 Compose v2），然后执行：

```sh
npm run desktop:setup
npm run test:desktop
```

脚本依次使用 `OBSIDIAN_SYNC_GO` 指定的编译器、项目 `.local/toolchains/go/bin/go`、PATH 中的 `go`。PostgreSQL 仅使用本项目专属 Docker 容器与 volume；测试使用独立 schema，不清理其他项目资源。

`desktop:setup` 会更新生成的 A/B 测试库插件，保留已有身份与笔记。它不启动 Obsidian 或 HTTP 服务；手动测试时另运行 `npm run desktop:start`，不要在同一端口启动第二份服务。仅使用生成假库，完整流程见 [电脑验证](docs/testing/desktop.md)。

GitHub Actions 将执行类型检查、默认测试、两个插件构建、Go vet、Docker PostgreSQL 合同/race 测试和双客户端集成。自动化中的 fake IndexedDB 不能替代 Obsidian 和移动真机验收。

## 提交内容

- 提交源代码、固定依赖、设计、迁移/协议说明与可公开的测试证据。
- 不提交 `.local/`、`node_modules/`、构建产物、生成测试库、数据库、真实笔记、口令、令牌和解锁记录。不要使用 `git add -f` 绕过忽略规则。
- 提交前运行 `git diff --check`，检查 `git status --short` 和暂存区；截图也需检查是否包含私人内容。
- 变更说明写清触发场景、行为与验证边界，不将同机双库写成物理双机或 iPhone 结果。

## 许可状态

本项目采用 [MIT License](LICENSE)。官方插件模板的 0BSD 和依赖保留各自许可，见 [模板来源](plugin/TEMPLATE.md) 与 `plugin/licenses/`；构建包同时携带项目 LICENSE 和相应上游声明。
