# xSync

[English](README.md) | 简体中文

使用自建服务器，在自己的设备之间端到端加密同步 Obsidian 笔记库。支持多个用户，可以和朋友共用一台服务，各自管理自己的知识库；服务端无法解密知识库内容。

[安装 xSync](https://community.obsidian.md/plugins/xsync) · [自建服务](docs/DEPLOYMENT.md) · [安装与接入](docs/SETUP.md)

免费开源。插件和管理后台均支持简体中文与 English，可分别切换并记住选择。

## 功能

- 多用户使用：为自己和朋友创建独立用户，使用各自的访问 key 与同步库。
- 端到端加密：同步笔记、附件和可共享配置，服务端无法解密内容。
- 对比冲突、选择版本、保留双方、手动合并文本，或暂缓处理，让其他文件继续同步。
- 每台设备独立设置文件大小、目录、后缀和正则排除规则。
- 使用已保存密钥暂停、恢复；持久化队列恢复中断任务，回到前台后自动补齐。

## 快速开始

1. **部署服务**：使用 Docker Hub 镜像 [`ycw0818/xsync-server`](https://hub.docker.com/r/ycw0818/xsync-server)，按[部署说明](docs/DEPLOYMENT.md)启动。
2. **创建用户**：登录管理后台，创建用户并保存访问 key。
3. **连接插件**：在 Obsidian 中安装 xSync，填写服务地址与访问 key，再创建或加入同步库。详见[接入说明](docs/SETUP.md)。

## 使用要求

- Obsidian **1.14.4 或以上**；Android 的凭据存储适配与真机测试待完成。
- 服务端当前使用 PostgreSQL，SQLite 支持正在开发中。
- 支持前台同步和回前台自动补齐，不保证锁屏或后台持续运行。
- 保留当前文件与未解决冲突，不提供历史版本或回收站入口。首次使用前请备份笔记。

## 隐私

插件连接用户配置的自建服务，文件内容、路径和可共享配置快照均加密传输。服务端可见用户备注、库显示名称、设备名称、文件身份、长度和同步元数据，访问 key 用于连接授权，服务器只保存其摘要；不接收库加密密码或内容解密密钥。本机凭据由操作系统安全存储保护，不回退为明文。

没有分析统计、广告或插件自动更新器。设备凭据、工作区布局、核心插件启用列表和 xSync 自身文件留在本机。其他插件配置中的未知秘密字段可能需要手动排除。

## 开发与文档

开发与测试见[贡献指南](CONTRIBUTING.md)。

- [文档索引](docs/README.md)
- [安装与接入](docs/SETUP.md)、[自建服务](docs/DEPLOYMENT.md)
- [协议说明](protocol/README.md)
- [发布流程](docs/RELEASING.md)、[更新记录](CHANGELOG.md)

## 许可

采用 [MIT License](LICENSE)。上游模板与依赖声明保留在 [plugin/licenses](plugin/licenses)，详见[模板来源](plugin/TEMPLATE.md)。
