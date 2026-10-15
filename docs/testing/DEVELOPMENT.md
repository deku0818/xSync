# 开发与验证流程

## 日常检查

```sh
npm ci
npm run check
```

check 执行类型检查、默认测试与探针/同步插件构建。默认跳过需要真实后端或原生浏览器的集成；不得将跳过统计成通过。文件事件开发可用 npm run dev:plugin，回归可用 npm run test:watch。

## 后端与恢复

需要 Go >=1.27、Docker/Compose v2：

```sh
npm run desktop:setup
npm run test:desktop
```

PostgreSQL 只使用 obsidiansync-dev 专属 Docker 项目。test:desktop 执行 Go 合同/race、双客户端与故障恢复；找到 Chrome/Chromium 后运行独立 profile 的真实 IndexedDB/SIGKILL 套件，不操作已有浏览器会话。可用 OBSIDIAN_SYNC_CHROME 指定路径；CI 要求浏览器存在。

模型测试验证因果、幂等、分支、位置 CAS 和过期选择；文件/HTTP/PG 集成使用 fake IndexedDB；原生浏览器套件验证真实桌面 IndexedDB 的进程恢复。这些均不能替代 iOS/Android 的 Vault API、安全存储、系统终止和资源验收。错误注入、进程强杀、物理断电及联合备份实际还原须分别记录。

## 真机

仅用独立假库，按[移动说明](mobile-probe.md)验证。重点包括并发修改、删除/编辑、重命名/编辑、过期审阅、暂停保持、前台补齐、强退/系统回收、弱网和资源限制。iOS 后台测试关闭调试连接，不承诺持续后台执行。进程内存使用原生证据，JS heap 不代替进程峰值。

## 结果与清理

截图、JSON、日志和临时结果放在 .local/reports/ 等忽略目录，不提交到 docs 或源码目录。保留测试源码、固定依赖、协议不变量与长期说明；历史验收结果已按用户要求移除。

本地假库、配置与数据库已清理。重新验证先 setup，不复用旧客户端身份；[电脑说明](desktop.md)列出资源位置和清理方式。无需验证时不要运行构建后再将生成物作为源码提交。

浏览器探针仍可复现：

```sh
npm run build:probe
python3 -m http.server 8872 --bind 127.0.0.1 --directory tests/probe
```

打开 tests/probe/browser-smoke.html 对应的本机地址。它不读取 Vault，也不是手机验证。
