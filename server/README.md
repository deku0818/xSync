# 服务端

xSync Go/pgx HTTP 服务，PostgreSQL 元数据和先耐久发布的不可变密文对象。服务端不持有内容解密密钥。PostgreSQL **只使用 Docker**，不得安装/运行宿主 PG。

从根目录运行 npm run desktop:setup、npm run test:desktop、npm run desktop:start；完整资源与清理步骤见[电脑说明](../docs/testing/desktop.md)。本地旧测试配置和数据库已清理，需要重新 setup。

数据库固定绑定 loopback，HTTP 默认同样为 loopback。仅生成手机测试可显式使用 --dev-lan-listen，必须为私有 IP 和隔离 --test-schema。正式非 loopback 监听要求 TLS 证书和私钥，亦可由已有 HTTPS 代理转发至 loopback。--resume-test-schema 仅恢复存在的测试 schema 并保留数据，fresh 模式清理自身 schema，不混用环境或客户端身份。

接口包括 handshake、密文 objects、commits、changes、冻结 snapshots、device profiles，以及票据认证的 WebSocket events。唯一名称、加密快照 CAS、幂等请求、因果头、并发版本和条件解决已接入；事件只是提示，HTTP 负责补齐。iOS Origin 精确允许 capacitor://localhost，仍需第一帧单次票据。

对象上限为 16 MiB 密文；服务端不能直接校验 E2EE 明文长度。当前按库载入/发布状态，规模性能尚未验收。普通设备接入、临时窗口、同身份令牌恢复、永久撤销已实现，见[安装](../docs/SETUP.md)与[部署](../docs/DEPLOYMENT.md)。多实例通知、GC、对象回收、联合备份实际还原和协议迁移工具尚待实现。

数据库合同、race 与恢复测试源码保留；错误注入、Store 重开、进程强杀和物理断电不能互相替代。见[测试流程](../docs/testing/DEVELOPMENT.md)。
