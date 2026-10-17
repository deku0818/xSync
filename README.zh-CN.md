# xSync

[English](README.md) | 简体中文

使用自建服务器，在自己的设备之间端到端加密同步 Obsidian 笔记库。遇到冲突时保留各方修改，由用户明确审阅，不按时间、上传顺序或设备优先级决定覆盖。

[安装 xSync](https://community.obsidian.md/plugins/xsync) · [自建服务](docs/DEPLOYMENT.md) · [安装与接入](docs/SETUP.md)

免费开源，需要自己的 HTTPS 服务器。插件界面和详细指南目前为中文。

## 功能

- 端到端加密同步笔记、附件和可共享配置。
- 对比冲突、选择版本、保留双方、手动合并文本，或暂缓处理，让其他文件继续同步。
- 每台设备独立设置文件大小、目录、后缀和正则排除规则。
- 使用已保存密钥暂停、恢复；持久化队列恢复中断任务，回到前台后自动补齐。

## 快速开始

1. 按[部署说明](docs/DEPLOYMENT.md)准备服务。在自己的电脑运行 `npm run server:init -- --out .local/xsync-owner` 生成初始化文件，只把 `server.json` 送到服务器；`sync-key.txt` 留在自己的设备并单独备份。
2. 在 Obsidian 的“设置 → 第三方插件 → 浏览”中搜索 **xSync**，安装并启用。手动安装时，将 [GitHub Releases](https://github.com/deku0818/xSync/releases) 中的 `main.js`、`manifest.json` 和 `styles.css` 放到 `<配置目录>/plugins/xsync/`。
3. 填写设备名称、HTTPS 服务器地址和同步密钥，点击“保存并测试”。第一台设备接入后，新增设备需要管理员临时开放接入窗口。

已保存密钥、设备撤销和凭据恢复见[安装与接入](docs/SETUP.md)。

## 兼容性与限制

- 最低 Obsidian 版本为 **1.14.4**。目标平台是 macOS 和 iOS；Android 尚无安全存储适配，Windows/Linux 尚未完成真机验证。iOS 依赖宿主内部原生桥接，需要按宿主版本验证。
- 服务端支持 **PostgreSQL**，SQLite 尚未实现。
- 支持前台同步和回前台自动补齐，不保证锁屏或后台持续运行。传输虽已分块，源文件仍整读。
- 同步范围为当前文件和未解决冲突，不提供历史版本或回收站入口。
- 请先使用独立测试库并保留备份。新版接入的真机验证、生产备份还原、密钥迁移、大文件资源验收和生产安全审查仍待完成。

当前源码包含尚未发布的协议变更。开发时应从同一提交构建插件与服务端；已发布的 0.1.2 插件不能连接当前源码服务端。升级要求见[协议兼容说明](docs/DEPLOYMENT.md#源码升级与协议兼容)。

## 隐私

插件连接用户配置的自建服务，文件内容、路径和可共享配置快照均加密传输。服务端可见设备名称、文件身份、长度和同步元数据，不接收同步密钥或内容解密密钥。本机凭据由操作系统安全存储保护，不回退为明文。

没有分析统计、广告或插件自动更新器。设备凭据、工作区布局、核心插件启用列表和 xSync 自身文件留在本机。其他插件配置中的未知秘密字段可能需要手动排除。

## 开发与文档

需要 Node.js >=22.12：

```sh
npm ci
npm run check
```

Go/PostgreSQL 集成与恢复测试见[贡献指南](CONTRIBUTING.md)和[开发流程](docs/testing/DEVELOPMENT.md)。

- [文档索引](docs/README.md)
- [安装与接入](docs/SETUP.md)、[自建服务](docs/DEPLOYMENT.md)
- [协议说明](protocol/README.md)
- [发布流程](docs/RELEASING.md)、[更新记录](CHANGELOG.md)

## 许可

采用 [MIT License](LICENSE)。上游模板与依赖声明保留在 [plugin/licenses](plugin/licenses)，详见[模板来源](plugin/TEMPLATE.md)。
