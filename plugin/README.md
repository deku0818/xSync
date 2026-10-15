# 插件

当前同步源码版本 0.0.10，入口 src/sync-main.ts；能力探针入口 src/main.ts，两者独立构建。模板来源与许可见 [TEMPLATE.md](TEMPLATE.md)。

npm run build:plugin 生成 dist/obsidian-sync-dev/；npm run build:probe 生成探针。desktop:setup 为独立电脑假库安装开发插件；启动仍要求自有测试标记与预置身份，不用于真实主库。

src/sync/ 为移动兼容的加密、状态机、持久化任务、恢复与文件适配；src/ui/ 提供连接/规则/客户端快照/冲突界面。已保存密钥固定圆点仅为占位，输入值为空，存在检查不解密记录。

桌面 safeStorage 与 iOS 原生 Keychain 保护器分离。iOS 依赖宿主内部桥接，缺少时拒绝保存，不回退明文；锁屏/迁移和资源合同仍需专项验收。普通文件使用 Vault API，配置使用 Adapter 和 configDir 映射。

本地安装包、测试库和旧验收结果已清理，构建时重新生成。开发方式见[电脑说明](../docs/testing/desktop.md)、[移动说明](../docs/testing/mobile-probe.md)，产品合同见[决策](../docs/DECISIONS.md)。
