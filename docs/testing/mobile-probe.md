# 移动端验证与探针

只使用独立假库。完整同步插件按[安装与接入](../SETUP.md)为每台设备独立注册身份，不能复制电脑身份作为另一台设备。能力探针独立于同步插件；手机测试目录由用户自行清理。

## 探针安装

```sh
npm ci
npm run package:probe
```

将 plugin/dist/obsidian-sync-probe/ 的构建文件和许可证安装到独立测试库的 <configDir>/plugins/obsidian-sync-probe/。可通过 iCloud 或 Finder → iPhone → 文件 → Obsidian 传入整个新测试库，不替换真实笔记库或已有同名库。

手机启用插件后运行移动端可行性探针，填写实际机型/系统版本，先测 1 MiB，再按需求逐级增加。明确记录强退、重启、后台、锁屏与调试器附加条件。探针不上传数据；插件加载门槛不等于正式支持范围。

## 验证重点

- IndexedDB 事务与跨 session 读取；插件重载不能替代实际强退/系统终止。
- Worker/WASM、Argon2id 与 AEAD 的错误密钥/密文/AAD 拒绝。
- 普通 Vault API、隐藏 Adapter、源文件整读/整写及真实资源边界。
- 完整插件的双向同步、冲突审阅更新、暂停保持、回前台自动补齐和传输中断恢复。
- iOS 原生安全存储在锁屏、重启首次解锁前、迁移和换机时的行为；即时写读成功不等于访问保护或设备绑定已验收。

所有源文件仍为整文件 ArrayBuffer，分块传输不等于源文件流式读取。JS heap 不等于整个 Obsidian 进程峰值内存；资源结论需原生 profiler/系统终止证据。回前台补齐不等于持续后台同步，测试时先关闭 Web Inspector。

原始报告只保留在本机忽略目录或假库中，不提交到仓库。探针普通合成文件位于 ObsidianSync-Probe-<随机ID>/，本地身份/报告/隐藏合成文件在 <configDir>/obsidian-sync-probe-local/，均不得参与共享同步。

## 清理手机

- 删除不再需要的独立测试库；除 Mobile-Test 外，也检查此前的 ObsidianSync-Probe-USB 等探针库和 Obsidian 库列表中的旧入口。
- 探针公开假标记 ID 为 obsidian-sync-probe-synthetic，可在 Obsidian 设置的钥匙串中仅移除该自有条目。
- iOS 同步保护器的原生包装密钥使用 obsidian-sync-wrap-v1- 前缀。当前没有卸载时批量清除逻辑，删除库文件夹不保证同时删除原生记录；精确清理需按本插件自有引用处理，不清空 Obsidian 共用钥匙串。
- App 的共享 IndexedDB/系统钥匙串可能包含其他库或插件的数据，不按整个应用目录删除。

公开 SecretStorage 的存在不等于本项目需要的 iOS 访问保护合同；当前适配依赖宿主内部 SecureStorage 桥接，缺少桥接时拒绝保存，无明文回退。官方开发依据见 [Obsidian 移动开发](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development)与 [SecretStorage 指南](https://docs.obsidian.md/plugins/guides/secret-storage)。
