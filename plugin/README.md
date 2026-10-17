# 插件

xSync 同步入口为 src/sync-main.ts，版本与同步 manifest 以仓库根目录为准；能力探针入口 src/main.ts，两者独立构建。模板来源与许可见 [TEMPLATE.md](TEMPLATE.md)。

npm run build:plugin 生成 dist/xsync/；npm run build:probe 生成探针。desktop:setup 为独立电脑假库安装插件；普通库自行初始化本机身份，通过服务器挑战证明持有同步密钥，不要求测试标记。实验 fixture 仅用于隔离回归。安装与平台限制见[说明](../docs/SETUP.md)。

src/sync/ 为移动兼容的加密、状态机、持久化任务、恢复与文件适配；src/ui/ 提供连接/规则/客户端快照/冲突界面。已保存密钥固定圆点仅为占位，输入值为空，存在检查不解密记录。

桌面 safeStorage 与 iOS 原生 Keychain 保护器分离。iOS 依赖宿主内部桥接，缺少时拒绝保存，不回退明文；锁屏/迁移和资源合同仍需专项验收。普通文件使用 Vault API，配置使用 Adapter 和 configDir 映射。

开发方式见[电脑说明](../docs/testing/desktop.md)、[移动说明](../docs/testing/mobile-probe.md)，同步语义见[协议说明](../protocol/README.md)。构建产物、测试库和运行结果不提交。
