# 当前交接

项目 /Users/y-pc/Cocoon/xSync，源码候选版本 **0.1.1**，已发布版本 **0.1.0**，正式名称 **xSync**，ID **xsync**。不修改 PalletTruck3D，不操作用户真实笔记库。

## 状态

用户已授权修复可修审查项、补充误报说明，官方预审无阻断错误后发布新版本。0.1.1 候选已接声明式设置搜索，保留原表单和清理生命周期；CSS 移除 !important；配置协议命名空间集中定义但原值保持不变，仍按 Vault.configDir 映射；Actions 增加三个安装文件的构建来源证明。社区 Release 仅上传三个安装文件，许可嵌入 main.js。误报与必需能力说明见 [REVIEW-NOTES](REVIEW-NOTES.md)。默认回归、CI 和官方预审完成状态以实际工具结果为准，未完成项不能记为通过。

0.1.0 已补普通库初始化、所有者本地初始化包、挑战签名设备接入、临时接入窗口、令牌恢复和永久撤销，以及标准发布包结构。已有加密双向同步、安全保存、暂停恢复、冲突处理和恢复队列。已保存密钥圆点方案已获批准并落地，真实输入值保持空。旧版 Mac/iPhone 验证不能代替新版本真机验收。

GitHub 0.1.0 Release 已发布；用户于 2026-10-15 在社区点击 Publish，[公开展示页](https://community.obsidian.md/plugins/xsync) 已可访问。官方审查完成且发布 main.js 可逐字节复现。展示页已补英文介绍、自建/平台限制、青色 cloud-sync 图标、分类与三张合成数据界面预览；README 和安装说明同步改为社区安装入口，保留未完成验收边界。界面已改为宿主 HTML 清洗和安全内联 SVG，保留批准的表单布局与状态切换；定时器通过宿主窗口适配，逻辑配置命名空间和同步格式保持原合同。发布和预审状态以 GitHub Release 与官方管理页为准，结果文件只在忽略目录。

此前已按用户要求清理中间文件、测试结果与冗余，保留 HTML；手机上的 Mobile-Test 由用户自行清理。旧电脑测试库、配对配置/对象/备份和历史验收报告均已移除。自动测试源码、HTML、开发依赖和本地 Go 工具链保留。本轮验证只重建隔离测试资源，完成后清理；发布包保留为本轮交付物，不提交生成物。不要使用旧 PID、身份或 schema 恢复已清理的配对服务。

Mac 上三个旧测试库入口、各自窗口状态文件和对应的三个同步 IndexedDB 已精确移除，其他库/插件的应用存储保留；未整体清除系统钥匙串或 Git 历史。手机部分由用户处理，本轮未复核原生钥匙串；清理说明见[移动说明](testing/mobile-probe.md)。

## 用户合同

- 个人多设备、自建服务、端到端加密；名称/地址/密钥保存并测试后自动同步，反馈区分连接、授权、名称、密钥、安全保存。
- 已保存密钥留空复用；固定圆点只是占位，存在检查不解密。新值验证并安全保存成功才替换，失败保留原配置。
- 日常仅暂停/恢复，保留配置，重开仍暂停；前台/重连自动补齐，不承诺持续后台运行。
- 冲突必须展示准确快照与实际设备名称，用户决定保留双方、某台版本、手动合并或暂不处理；新版本更新比较、保留草稿，其他文件继续。
- 本机规则独立；凭据、身份、布局、核心插件启用列表、队列/暂存与本插件固定排除。跳过不是删除，所选范围完成不等于范围外分支已解决。
- PostgreSQL 只使用本项目 Docker 容器/volume，不安装或运行宿主 PG，不清理其他项目资源。

## 实现入口

- plugin/src/sync-main.ts：宿主生命周期、串行队列、保存/恢复、前台重试和自动同步，不再要求测试标记；普通身份文件无令牌，令牌进入受保护记录。
- plugin/src/ui/、plugin/styles.css：批准的 HTML 对应真实界面，不打包演示脚本。
- plugin/src/sync/engine.ts：不可变 outbox、幂等回执优先、密文认证、接收/游标事务、应用 journal、租约和保守快照恢复。
- vault-port.ts、policy.ts、config-projection.ts：Vault/Adapter、configDir 映射、规则与已识别本机字段隔离。
- desktop/remembered-unlock.ts：跨平台受保护记录封装；desktop/protector.ts 为 safeStorage；mobile/ios-protector.ts 为原生 Keychain 桥接，无明文回退。
- server/internal/syncstore/：元数据、不可变密文对象、幂等/CAS、事件票据和加密设备快照。
- server/scripts/init.ts、protocol/src/enrollment.ts、plugin/src/sync/enrollment.ts：所有者本地初始化与跨语言接入；本机管理命令在 server/cmd/obsidiansync。
- manifest.json、versions.json、plugin/scripts/package-sync.mjs：发布元数据与包；手动 Actions 只生成构建产物。
- tests/：模型/属性、宿主/核心、真实数据库、多客户端与原生浏览器恢复测试；不是测试结果目录。

## 后续

1. 0.1.0 xSync 新安装与普通库接入的 Mac/iPhone 真机复验；新保护记录包含令牌，旧移动验收不能代替本轮。新增正式部署或下一版本发布需另行授权；当前 0.1.0 已由用户发布。
2. 数据库与密文对象联合备份、实际还原及旧设备重连核对。
3. iPhone 传输中系统终止、实际 move 应用中断、低存储/大附件峰值内存、网络切换、锁屏 Keychain 实效与重启/迁移。
4. Android、Windows/Linux 安全存储、物理双机、未知第三方私密字段、空目录/批量移动、高级附件/多头审阅、历史/GC 和安全审查。

本轮已在真实 Go HTTP、Docker PG 上验证新设备双向同步、接入窗口、回执重试、令牌更换和撤销后重启；宿主测试覆盖无标记初始化、原身份恢复和安全存储/设置指针失败。默认、数据库/race 与原生 IndexedDB 恢复套件保留，不重建历史结果文档。安装、运维和发布说明见 [SETUP](SETUP.md)、[DEPLOYMENT](DEPLOYMENT.md)、[RELEASING](RELEASING.md)。

100 MB 源文件仍整读；iOS 保护器依赖宿主内部桥接，须按版本验证。开发重建步骤见[电脑说明](testing/desktop.md)，测试边界见[流程](testing/DEVELOPMENT.md)。0.1.0 tag 保持在 74d1e0a，不改写旧版本或其资产；0.1.1 通过预审后另建 tag 与 Release，不部署服务或操作真实笔记库。
