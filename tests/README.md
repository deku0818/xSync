# 自动化测试源码

本目录保留可复现的测试、工具和夹具，不存放历史验收结果。

- protocol/：内存状态机、因果、幂等、分支与属性测试。
- probe/：探针辅助逻辑和浏览器冒烟入口 HTML。
- desktop/：宿主/核心单测、所有者初始化、设备接入及真实文件/HTTP/PG 双客户端、恢复矩阵与原生浏览器强杀工具。
- mobile/：iOS 保护器的假 native backend 合同，不能代替真机。

npm test 运行默认测试；npm run check 另做类型检查和构建。npm run test:desktop 在 setup 后运行数据库/race、多客户端与恢复，并在浏览器可用时运行独立 Chrome 原生 IndexedDB/SIGKILL，不操作已有用户浏览器。

生成假库、构建文件、截图、日志和 JSON 结果均不提交。开发环境与平台边界见[测试流程](../docs/testing/DEVELOPMENT.md)。
