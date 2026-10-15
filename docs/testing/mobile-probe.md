# iPhone 移动端可行性探针

状态：探针代码和安装目录已生成；尚无 iPhone 真机结果。仅用于独立测试库，不是同步插件。用户当前优先验证 iPhone；机型、iOS/Obsidian 版本和最大附件尚待填写。

## 安装到独立测试库

1. 在 iPhone 新建空白测试库，例如 `ObsidianSync-Probe-iPhone`。若使用 iCloud 方便从 Mac 传文件，确保它是独立空库。
2. 项目根运行 `npm ci`、`npm run build:probe`。安装目录是 `plugin/dist/obsidian-sync-probe/`。需要 ZIP 时运行 `npm run package:probe`（额外需要 Python 3），输出 `plugin/dist/obsidian-sync-probe-0.0.1.zip`，解压后安装。
3. 将该目录中的 `main.js`、`manifest.json`、`THIRD-PARTY-NOTICES.txt` 放进测试库的 `<配置目录>/plugins/obsidian-sync-probe/`。默认配置目录为 `.obsidian`，自定义时使用实际目录。可以从 Mac Finder 的 iCloud 测试库复制；按 Command+Shift+. 显示隐藏文件。等待三个文件传完再启动。
4. 在 iPhone 的 Obsidian 设置中启用该测试插件，命令面板运行 `ObsidianSync Platform Probe: 运行移动端可行性探针`。插件 `minAppVersion` 是实验探针加载门槛，不表示已验证的产品支持版本。
5. 填设备实际名称、机型、系统版本；先选 1 MiB，确认是独立测试库后运行。随后逐轮尝试 8 / 32 / 64 / 128 MiB，按实际附件需求决定是否继续。每轮单独报告；崩溃或明显资源不足时记录结果，支持上限仍待决定。

本聊天不会自动安装插件或操作任何真实笔记库。安装包包含已固定版本的依赖；没有远端仓库、上传服务或网络探测请求。

## 测什么

| 探针 | 自动检查 | 仍需人工确认 |
| --- | --- | --- |
| IndexedDB / Dexie | task 与 received marker 一起提交；中途抛错一起回滚；读取旧 session marker | 强制退出/重启后保留、系统回收后行为；清除数据库后的保守重接入尚无引擎 |
| Worker / WASM | Blob Worker 启动，实例化并执行返回 42 的 WASM | WKWebView 真机是否允许同一路径；后台中断/恢复 |
| KDF / AEAD | Worker 中 Argon2id13，64 MiB、ops=2；加密往返；错误密钥/密文/AAD 拒绝 | 解锁延迟、UI 体验和进程峰值内存；libsodium 默认 WASM/JS 路径未区分 |
| 普通文件 | Vault.create/read/process；二进制 createBinary/readBinary，全字节比对 | iPhone 内存和系统终止；与外部写入竞争另需故障测试 |
| 隐藏本地文件 | 通过 Vault.configDir + Adapter 写读同大小合成文件 | 实际空间、恢复和写满行为 |
| SecretStorage | 仅自有 ID 的公开假令牌写读，后续查看旧标记 | iOS 安全存储机制、锁屏访问策略、设备独立性、迁移/备份边界 |

**所有源文件读写都是整文件 ArrayBuffer，不是流式读取。** 逐级测试只说明该轮大小在该设备上的表现，不足以确定任意大附件支持。当前不实现 FastCDC 或生产密钥封装。

报告里的 `pass` 是某一步执行完成；全轮仍保留 `unverified` 的人工验收项。`previousSessionMarkers > 0` 只证明另一插件 session 的记录可读，可能来自插件重载；只有你确认做了强制退出，才能作为该次重启证据。

## 报告与中断

- 普通合成文件保留在新建的 `ObsidianSync-Probe-<随机ID>/` 目录。
- 本地身份、报告和 Adapter 合成文件在 `<configDir>/obsidian-sync-probe-local/`；测试后可整体移走/删除。它们必须硬排除出共享同步；独立探针自身不含同步引擎，后续电脑开发插件也排除了整个 configDir。
- 每步执行前保存 `running`，执行后保存结果；如果应用被终止，重新启动后用“查看上次探针报告”读取停在哪一步。报告写本身不是原子文件事务，若 JSON 损坏请保留原文件作为证据，不能当作恢复能力通过。
- 报告窗口可选择复制 JSON。提交两份前后报告时一并说明是否杀进程、后台多久、是否锁屏和是否连接充电/调试器。
- “停止后续步骤”会终止 Worker 并跳过后续步骤；已开始的 Vault/Adapter I/O 无法取消，等待该步结束。卸载插件也发出取消请求。
- 假 SecretStorage 标记 ID 为 `obsidian-sync-probe-synthetic`，值是公开测试字符串，没有真实凭据。测试后可在设置的 Keychain 中移除。API 未提供时记录不可用，不换用 data.json 存真实密钥。

## iPhone 必须补做的过程

1. 1 MiB 全轮完成，保存报告。
2. 从应用切换器强制退出 Obsidian，重新启动同一测试库，再运行，核对旧 session marker；重启手机后再做一轮。插件重载不能代替这一步。
3. 运行 KDF/较大附件期间切后台、锁屏，再回来；记录是否崩溃、最后 running 步骤和后续能否重跑。当前没有生产同步恢复引擎，不能据此声称任务恢复已经实现。
4. 按附件阶梯逐级运行并记录读写时间与可见卡顿。`maxTimerGapMs` 是主线程定时器采样间隔（也受系统暂停影响），不是 FPS、触摸延迟或进程内存。
5. iOS 16.4+ 可以用 Mac Safari 的 Web Inspector 连接实际 Obsidian WebView。[Obsidian 官方移动开发说明](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development) 和 [WebKit 设置说明](https://webkit.org/web-inspector/enabling-web-inspector/)。记录系统版本、Obsidian 完整版本和测量条件；报告的 apiVersion 不代表安装器/原生壳版本。
6. Web Inspector 的 JS 堆统计不等于整个 Obsidian 进程峰值内存。只有可用的原生诊断/分析工具允许观察目标进程时才补进程证据；不能附加时保持 `unmeasured`。系统内存终止也要记录，不能把“没有捕获到崩溃”当作内存达标。
7. 单独核对凭据存储的 OS 保护、跨 Vault/设备范围及锁屏行为，未完成前产品只采用会话解锁。

## 存储依据与限制

公开 API `SecretStorage` 从 1.11.4 起提供 set/get/list；[官方指南](https://docs.obsidian.md/plugins/guides/secret-storage)描述为按库关联的 local storage，允许多个插件引用同一凭据。指南不提供本项目要求的 iOS Keychain 访问级别、设备绑定和备份合同。因此本轮不把 API 可用性等同于“可安全记住库主密钥”。探针也不枚举其他秘密、不读取真实令牌。

候选加密包和 KDF 参数依据 [libsodium.js](https://github.com/jedisct1/libsodium.js) 与 [libsodium Argon2 参数说明](https://doc.libsodium.org/password_hashing/default_phf)；64 MiB/ops=2 是测量起点，非最终发布参数。没有静默降低 KDF 或失败后初始化远端的路径。
