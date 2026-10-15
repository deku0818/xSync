# xSync 发布准备

正式名称 **xSync**、ID **xsync**；本地目录与 GitHub 仓库名统一为 xSync：`/Users/y-pc/Cocoon/xSync`、`deku0818/xSync`。`manifest.json` 是同步插件的唯一 manifest 来源，当前版本 0.1.0；探针继续使用独立的 `plugin/manifest.json`。`versions.json` 映射最低宿主版本，目前保守设为 1.14.5。

本地构建：

```sh
npm ci
npm run check
npm run package:plugin
```

`dist/release/` 包含 `main.js`、`manifest.json`、`styles.css`、带插件目录的 ZIP、许可与依赖声明，以及 SHA256SUMS。生成物被 Git 忽略，不能提交设备配置、令牌、密钥、本地测试库或验收截图。最低版本映射和 manifest 不一致时打包失败。

GitHub Actions 的常规检查验证类型、自动测试、构建、发布包、Docker PG、race 和原生浏览器恢复。另有手动 `Prepare xSync package` 工作流，只上传任务构建产物，**不会打 tag、创建 Release 或提交社区目录**。仓库提交和推送不等于发布。

正式发布时需另外明确授权，再创建与 manifest 一致的 **`0.1.0`** tag（不加 v），在 GitHub Release 附上三个插件文件及许可/压缩包。根目录已提供 README、MIT LICENSE 与 manifest；社区申请按 [Obsidian 官方提交流程](https://docs.obsidian.md/plugins/releasing/submit-plugin) 进行。命名约束见[Manifest 文档](https://docs.obsidian.md/Reference/Manifest)。当前目录查询未发现 xsync / xSync，最终是否接受由审核决定，不能预留或保证名称唯一。

提交前仍需完成 0.1.0 普通库接入的 Mac/iPhone 安装与恢复验证，复核网络/隐私披露、安全存储和内部 iOS 桥接兼容性，并明确预发布限制。联合备份还原、安全审查和其他平台尚未完成，不宣传已通过。插件只连接用户配置的自建同步服务，无分析统计、广告或自动更新器。
