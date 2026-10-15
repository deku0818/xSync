# 新窗口交接

更新日期：2026-10-15（Asia/Shanghai）。项目 `/Users/y-pc/Cocoon/ObsidianSync`，不修改 PalletTruck3D。

## 当前合同与状态

用户已审阅 `design/connection-settings.html` 和 `design/sync-conflicts.html`，明确要求按两份 HTML 实现，不再停留在设计讨论。

当前开发版本 **0.0.6**，Phase 02 桌面闭环。实现、验证与限制以 [本轮验收](testing/desktop-v006-2026-10-15.md) 为准；结果 JSON 同目录。不是生产整库或手机验收版本。

2026-10-15 已按用户“准备提交 GitHub”整理 README、文档索引、贡献指南、忽略规则和 GitHub Actions；Go 开发入口支持显式覆盖/项目本地/PATH。默认 59、Docker 合同 14（race）、双客户端集成 16 项重新通过，纯待提交文件导出的 `npm ci` / `check` 通过。用户随后选择 MIT，并授权 Git 提交、创建公开仓库 deku0818/ObsidianSync 和推送；根 LICENSE、npm 元数据和构建包均携带许可。GitHub Actions 远端结果以实际运行记录为准。详见 [仓库整理记录](testing/repository-2026-10-15.md)。

已确认：个人多设备/自建/E2EE；地址+客户端名称+密钥，保存并测试后自动同步；密钥留空复用、系统安全存储保护；日常仅暂停/恢复，保留凭据，重开不解除暂停。冲突必须用户决定准确快照，无默认赢家；新版本清除旧选择、保留草稿，其他文件继续同步。

2026-10-15 UI 补修：Obsidian 1.14.4 的 `.vertical-tab-content` 标题 padding 和通用 `.card` 左右 margin 导致标题缩进、表单与 section 卡片宽度不一致。在 `.oss-app` 内清零标题 padding，并显式重置卡片布局/外边距；未改动设计交互或同步逻辑。`npm run build:plugin` 通过，样式已更新到生成 A/B 测试库；重新加载 A 插件并重开设置窗口后，真实 UI 已目视确认“连接配置”与“本机同步规则”标题、字段左边缘对齐，卡片宽度一致。B 本轮只更新样式文件，未做窗口目视验收；没有重跑同步/数据库测试。

用户此次批准的新增内容已接入：

- 1–100 MB（十进制，硬上限 100,000,000 字节）、后缀/文件夹/RE2 正则，本机独立生效。
- 服务端同 vault 规范化名称唯一；每设备加密配置快照与 CAS，只读查看其他设备，不自动套用。
- `.obsidian`/实际 `Vault.configDir` 下主题、插件和可共享配置；固定排除密钥、身份、workspace、本插件、队列/暂存/缓存等。JSON 识别的凭据字段与数组保持各设备独立，未知自定义私密字段仍需适配。
- 真实排除树、整目录标注、懒展开/分页、居中 SVG 箭头。
- 同步概览/并排差异、保留双方位置预览、采用版本、手动合并、加密草稿、过期及位置 CAS。

## 实现入口

- `plugin/src/sync/policy.ts`：统一规则、100 MB、4 MiB 块、RE2JS 2.8.6；普通文件与配置同策略，固定排除不能关闭。
- `plugin/src/sync/vault-port.ts`：普通 Vault API、配置 Adapter，线上逻辑 `.obsidian` 映射实际 configDir；元数据轮询，按需索引，不主动热启用第三方代码。
- `plugin/src/sync/config-projection.ts`：已识别 JSON 本机字段隔离、接收时合并保留、保护同步插件自身启用状态；凭据数组不按下标拼接。
- `plugin/src/sync/engine.ts`：接收先于捕获；独立无父分支；排除不产生删除；保留 outbox/inbox/journal；分块上传、manifest 边界接收；准确文本合并/位置 CAS。
- `plugin/src/ui/connection-form.ts`、`sync-panels.ts`、`templates.ts`、`diff-lines.ts` 与 `plugin/styles.css`：已审阅 HTML 的静态 markup 移植，实际数据与 handler 替代演示脚本，作用域限制在 `.oss-app`。
- `server/internal/syncstore/profiles.go`：GET `/devices`、PUT `/device/profile`，授权只更新自身；NFKC/case-fold 唯一名称、revision CAS、同请求丢回执重试。
- 本机连接设置 format=3；旧解锁材料 format=0 保持，只扩展设置；Dexie schema=4 增加 skipped/加密 mergeDrafts/reconciliations，未清空已有 DB。
- wire 仍实验 v0，新增 branch 与 profile API/能力标志，两端应一起升级；加密主密钥、epoch、旧对象不迁移。

## 本轮关键恢复修复

真实旧 A 检查点并发初始化配置时产生 PATH_OCCUPIED 与本机路径身份冲突，原先单个恢复任务会卡住无关文件。只有明确拒绝的单文件 create 才归档原操作/身份/journal，再用实际字节核对；相同字节接入精确修订，不同内容保留独立根，绝不假设远端是本地祖先。原记录在 rejectedOutbox/reconciliations 保留，未知或复杂移动不猜测修复。恢复任务隔离失败，lease/锁定失败仍全局停止。

A 修复后新假笔记自动到达 B；受控冲突中 B 再编辑，A 清除选择保留草稿，重新合并后 A/B 字节一致。隐藏 CSS 与共享 JSON 传播、接收端假 API key 保持本机值，也在真实 Obsidian 验证。

## 验证结果

- `npm run check`：**59 项默认测试**、类型检查和两种构建通过；默认跳过 16 项需后端集成。
- `npm run test:desktop`：**14 项真实 Docker PostgreSQL/事件/profile 合同（race）+ 16 项双客户端集成**通过。
- 包括准确 100 MB 实际传输逐字节比较、100 MB+1 拒绝、目录/正则/后缀、排除与重纳入、独立根/归档中断、合并草稿/过期/位置变化、配置字段隔离与唯一名称并发。
- 自动集成本地 DB 为 fake-indexeddb，真实 Obsidian A/B 另用真实 IndexedDB/Vault API；同机双库不是物理双机。

## 本机运行

Docker Compose 项目 `obsidiansync-dev`，容器 `obsidiansync-dev-postgres-1`，PG 镜像 `postgres:17.11-alpine`，仅 **127.0.0.1:55438**，卷 `obsidiansync-dev_postgres-data`。不操作其他项目资源，不使用宿主 PG。

本机 Go 服务 **127.0.0.1:8873**。此次仅重启了已确认属于本项目的开发服务；PG/卷保持。启动命令 `npm run desktop:start`，当前服务保持运行，先查监听再起第二份。配置/令牌 `.local/desktop/server.json`，不可输出秘密；对象 `.local/desktop/objects`。

生成的假库：

- `tests/desktop/vaults/ObsidianSync-电脑A`
- `tests/desktop/vaults/ObsidianSync-电脑B`

本轮安装自有 0.0.6 插件、保留身份与笔记。A/B 自动同步保持开启；测试过程中 B 曾临时设 20 MB/docs/.tmp/正则，验收后恢复 100 MB 和空排除规则。新增假笔记、未激活 CSS snippet 和含公开假 API key 的 JSON 用于验收，详见本轮记录，不代表操作真实库。

本机私有记录 `<configDir>/obsidian-sync-local/desktop-unlock.json` 或随机 `connection-*.json` 只有 OS 保护密文；设备令牌仍在 device.json，排除共享。插件 data.json 保存本机规则和 profile 密文队列，不保存明文库口令/会话密钥。本插件没有在社区商店发布。

## 后续与边界

正式设备接入/撤销/轮换、Windows/Linux安全存储、iPhone/Android真机、物理双机、完整强杀/断电/大库资源验证、空目录/批量移动、附件/多于两头的完整审阅、复杂位置恢复、历史/GC、联合备份和发布安全审查仍待完成。

100 MB 的源文件仍整读，不能称为流式源文件；服务端因 E2EE 只能限制密文，不可声称直接校验明文大小。未知第三方私密字段不能凭通用规则保证识别，使用真实库前必须审查/适配。共享配置变化部分需重载 Obsidian 后生效，不自动重启影响其他真实库。

历史证据保留：0.0.3 自动化、0.0.4 配置暂停、0.0.5 设置/测试；其中默认流程和旧 4 MiB 限制不再作为当前版本说明。HTML 保留为交互设计参考，不直接执行其演示脚本。
