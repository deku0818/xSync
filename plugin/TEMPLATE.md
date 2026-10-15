# 官方插件模板来源

正式同步开发插件的 `sync-main.ts` 和 `esbuild.sync.mjs` 以 [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin/tree/07ceb81d1fb3384af611ebf665a1ec42a7e5926d) 为骨架，快照 `07ceb81d1fb3384af611ebf665a1ec42a7e5926d`，2026-10-14 获取。保留 `Plugin` 生命周期、ribbon、命令、状态栏、`PluginSettingTab`、注册事件/定时器与 CommonJS/esbuild 构建方式。

已将示例功能替换为项目同步能力，按根目录职责拆分核心与宿主 API；不另建嵌套 Git 仓库。能力探针只将 `obsidian` 作为 external；同步开发插件额外允许桌面安全存储适配层使用 `@electron/remote` / `node:buffer`，构建检查禁止其流入移动兼容核心，不沿用示例对全部 Node/Electron 模块的默认放行。

上游采用 0BSD；许可保存在 `licenses/obsidian-sample-plugin-0BSD.txt`，随构建产物一起分发。能力探针仍独立保留，ID 为 `obsidian-sync-probe`；正式开发插件 ID 为 `obsidian-sync-dev`。
