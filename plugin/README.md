# 插件职责

当前有两个独立构建：`src/main.ts` 为能力探针，`src/sync-main.ts` 为官方 sample-plugin 骨架上的实验同步插件，`src/sync/` 为可测试的加密、持久化任务、恢复和 Vault API 适配。模板来源见 [TEMPLATE.md](TEMPLATE.md)。

`npm run build:plugin` 生成 `dist/obsidian-sync-dev/`，`npm run desktop:setup` 更新两个生成的电脑测试库。开发插件启动必须有自有测试库标记/本地配置，支持普通文件与可共享配置。

当前 0.0.6 已按审阅 HTML 接入 `src/ui/connection-form.ts`、`src/ui/sync-panels.ts` 和作用域 CSS，提供唯一名称、设备规则/加密快照、真实排除树、同步概览、准确冲突和手动合并。1–100 MB、文件夹/后缀/RE2 正则按设备独立；配置由 Adapter 访问。桌面 safeStorage 与移动兼容核心分离。证据与限制见 [0.0.6 验收](../docs/testing/desktop-v006-2026-10-15.md)，手机、物理双机和生产安全审查仍待完成。

运行 `npm run build:probe` 生成 `dist/obsidian-sync-probe/`。iPhone 安装与验收见 [移动探针说明](../docs/testing/mobile-probe.md)。仅安装到独立空白测试库，当前尚无真机结果。

预期负责 Obsidian 生命周期、Vault / Adapter 文件访问、IndexedDB 本地状态、加密暂存、同步状态机、冲突选择、设备配置与状态 UI。核心需兼容电脑和手机。

实施前先阅读 `../AGENTS.md`、`../docs/DECISIONS.md`，并验证移动平台能力。
