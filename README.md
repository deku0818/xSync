# ObsidianSync

个人多设备 Obsidian 整库同步插件与自建同步服务。

当前阶段：**整体设计与项目初始化，尚未实现插件、服务端或同步引擎。**

## 从这里开始

- [整体架构设计（HTML）](design/architecture.html)：方案比较、架构、数据模型、同步协议、加密、冲突、恢复与验证计划。
- [新窗口交接](docs/HANDOFF.md)：已确认需求、当前状态、下一步与未决事项。
- [需求与设计决策](docs/DECISIONS.md)：区分用户确认的行为与待验证的技术推荐。
- [LiveSync 调研](docs/research/self-hosted-livesync.md)：源码快照、机制分析与参考边界。
- [项目工作约定](AGENTS.md)：后续协作的范围和验证要求。

## 已确认的目标

1. 同步到自己的服务器，支持电脑与手机。
2. 同步笔记、附件与可共享配置，包括插件、主题和设置。
3. 端到端加密，服务端不获得文件内容与真实路径的解密密钥。
4. 个人多设备使用，暂不考虑多人共享。
5. 独立设计和实现，Self-hosted LiveSync 仅作为参考；不以复用上游或减少工作量为目标。
6. 重叠修改由用户明确选择：都保留、使用某台设备版本，也可手动合并或暂不处理。

前台近实时同步纳入设计：电脑编辑后，手机打开 Obsidian 时自动跟随；后台 / 锁屏持续运行不作保证。延迟与大附件支持范围需要真实设备验证。

## 推荐架构（提案）

```text
Vault ↔ TypeScript 插件 / 同步状态机 / IndexedDB
                     ↕ HTTPS + 通知
                  Go 同步服务
                     ↕
        PostgreSQL 元数据 + 不可变密文对象存储
```

稳定文件身份、位置记录和内容修订分别建模；条件提交、因果分支、幂等操作和持久化任务保证可解释的同步行为。PostgreSQL、Go、Dexie、加密算法与分块参数是当前推荐，不表示已实现或经过性能 / 安全验证。

## 查看设计页面

可以直接用浏览器打开 `design/architecture.html`；页面没有外部脚本、字体或样式依赖。

也可以在项目根目录运行：

```sh
make preview
```

然后打开 <http://127.0.0.1:8870/architecture.html>。端口可覆盖：

```sh
make preview PREVIEW_PORT=8871
```

这是文档预览服务，只绑定本机。页面包含方案切换、六组过程讲解和浏览器打印入口；它们不是同步实现。

## 目录

```text
AGENTS.md                 项目工作约定
README.md                 项目入口
Makefile                  本地文档预览
design/
  architecture.html       自包含整体设计文档
  preview.png             整体页面预览
  conflict-preview.png    冲突选择设计预览
docs/
  HANDOFF.md              新窗口交接
  DECISIONS.md            需求与技术决策状态
  research/
    self-hosted-livesync.md
plugin/                   插件实现预留，目前只有职责说明
server/                   服务端实现预留，目前只有职责说明
protocol/                 协议定义预留，目前只有职责说明
tests/                    验证计划，目前没有可执行测试
```

目前没有安装运行依赖，没有创建 `package.json` / `go.mod`，也没有部署或连接任何真实 Vault、服务器或账户。具体依赖版本在进入实现和平台验证时确定。项目名称暂用 ObsidianSync，发布名称与许可证尚未确定。
