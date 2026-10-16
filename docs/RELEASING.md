# xSync 发布准备

正式名称 **xSync**、ID **xsync**；本地目录与 GitHub 仓库名统一为 xSync：`/Users/y-pc/Cocoon/xSync`、`deku0818/xSync`。`manifest.json` 是同步插件的唯一 manifest 来源，当前版本 0.1.1；探针继续使用独立的 `plugin/manifest.json`。`versions.json` 映射最低宿主版本，目前保守设为 1.14.5。

本地构建：

```sh
npm ci
npm run check
npm run package:plugin
```

`dist/release/` 包含 `main.js`、`manifest.json`、`styles.css`、带插件目录的 ZIP、许可与依赖声明，以及 SHA256SUMS。生成物被 Git 忽略，不能提交设备配置、令牌、密钥、本地测试库或验收截图。最低版本映射和 manifest 不一致时打包失败。

GitHub Actions 的常规检查验证类型、自动测试、构建、发布包、Docker PG、race 和原生浏览器恢复。另有手动 `Prepare xSync package` 工作流，为三个安装文件生成 GitHub 来源证明并上传构建产物，**不会打 tag、创建 Release 或提交社区目录**。仓库提交和推送不等于发布。

## 服务端 Docker Hub 镜像

`.github/workflows/dockerhub.yml` 提供独立的 **Publish server to Docker Hub** 工作流。目标为 `ycw0818/xsync-server`，只打包 Go 服务端，不含插件、PostgreSQL、配置、同步密钥或数据。按 Docker 官方 [Actions 构建方式](https://docs.docker.com/build/ci/github-actions/multi-platform/) 构建 `linux/amd64` 与 `linux/arm64`，附带 OCI 源码版本标签、BuildKit provenance 与 SBOM；不等同于插件的 GitHub 文件来源证明。

首次配置：

1. 在 Docker Hub 创建 `ycw0818/xsync-server` 仓库；供其他用户直接拉取时设为 Public。
2. 创建用于 CI 的 [Docker Hub personal access token](https://docs.docker.com/security/access-tokens/personal-access-tokens/)，权限为 Read & Write；不需要 Delete。令牌只放入 GitHub Secret，不写入代码或聊天。
3. 打开 GitHub 仓库 **Settings → Secrets and variables → Actions**，添加：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Repository variable | `DOCKERHUB_USERNAME` | `ycw0818` |
| Repository variable | `DOCKERHUB_IMAGE` | `ycw0818/xsync-server` |
| Repository secret | `DOCKERHUB_TOKEN` | 上一步生成的访问令牌 |

`DOCKERHUB_IMAGE` 可省略，默认使用 `<DOCKERHUB_USERNAME>/xsync-server`。私有镜像的部署机器还需自行登录 Docker Hub。

工作流合入默认分支后，在 **Actions → Publish server to Docker Hub → Run workflow** 选择包含新工作流和 Dockerfile 的分支，再填写 `image_tag`：

- `edge`：手动构建选中分支的当前提交，不更新 `latest`。
- 当前 `manifest.json` 的准确版本（例如 `0.1.1`）：用于首次补发服务端镜像，不改写 GitHub 旧 tag/Release，也不更新 `latest`。镜像源码以运行记录、完整 `sha-<commit>` 标签和 OCI revision 为准，可能包含旧插件发布之后的 CI/文档提交。
- 后续发布 GitHub Release 时自动构建该 Release 的准确提交；tag 必须与 manifest 版本相同且不加 `v`。正式 Release 上传版本标签和 `latest`；prerelease 不更新 `latest`。

所有上传均额外生成完整 `sha-<commit>` 标签，Actions 摘要记录镜像 digest。版本标签可被重新运行覆盖；部署需要固定内容时使用 `ycw0818/xsync-server@sha256:<digest>`。不要通过补发旧的正式 Release 更新 `latest`，否则它会指向旧版本。

上传前复用 `check.yml` 的完整验证，包括数据库合同/race、浏览器恢复，以及两种架构镜像的构建和入口冒烟检查；任何检查失败均不上传。普通 push/PR 只检查，不登录 Docker Hub、不推送镜像。首次补发旧版本应使用包含新 CI 的分支手动运行，不能对缺少工作流/Dockerfile 的旧 tag 直接运行。新 Release 对应的提交必须包含这些文件。

镜像运行与持久化方式见[部署说明](DEPLOYMENT.md#使用服务端镜像)。新增工作流不表示已经上传镜像或完成部署验收。

## 插件发布流程

发布需用户授权，tag 必须与 manifest 一致（候选 **`0.1.1`**，不加 v）。官方 Review branch 对准确提交预审无阻断错误，且常规 CI 成功后，运行同一提交的手动打包工作流。下载其原始产物，核对 manifest 版本与 SHA256SUMS，并用 `gh attestation verify` 验证三份文件来源；原样附到 GitHub Release，不重新构建或修改。自 0.1.1 起只附 `main.js`、`manifest.json`、`styles.css`，许可嵌入 main.js，ZIP/校验和等留在本地与 Actions 产物。详细误报说明见 [REVIEW-NOTES](REVIEW-NOTES.md)。根目录已提供中英文 README、MIT LICENSE 与 manifest；社区申请按 [Obsidian 官方提交流程](https://docs.obsidian.md/plugins/releasing/submit-plugin) 进行。命名约束见[Manifest 文档](https://docs.obsidian.md/Reference/Manifest)。

**当前状态（2026-10-15）**：GitHub [0.1.0 Release](https://github.com/deku0818/xSync/releases/tag/0.1.0) 已发布，用户已在社区点击 Publish，[公开展示页](https://community.obsidian.md/plugins/xsync) 已可访问；管理入口为[官方管理页](https://community.obsidian.md/account/plugins/xsync)。展示页已补英文介绍、自建/平台限制、青色 cloud-sync 图标、Syncing / Files / Attachments 分类及三张合成数据界面预览。预览不作为原生应用截图或真机验收证据。后续文档和展示文案更新不改写已发布 tag 或构建资产。

[0.1.1 Release](https://github.com/deku0818/xSync/releases/tag/0.1.1) 已在准确提交 755b7c7 通过官方预审、完整 CI、打包和来源证明验证后发布。三个安装文件原样来自 Actions，上传摘要已逐项核对。目录已完成发布后扫描（Completed，无阻断错误），公开版本为 0.1.1；main.js/styles.css 来源证明与逐字节构建复现均 Pass，不再附多余下载文件。Review 已由 Caution（36 项）升至 Satisfactory（3 项）。协议路径常量误报、RE2JS 普通方法名和必要的整库枚举保留说明，不能为了改标签更改同步语义或隐藏依赖代码。

界面模板通过 Obsidian 的 `sanitizeHTMLToDom` 挂载，图标使用受清洗支持的内联 SVG 图形；用户和服务器数据仍只写入 textContent/value。宿主和共享核心通过窗口定时器适配层兼容浏览器与无 window 的 Worker/Node 测试。`.obsidian` 在协议核心中是固定逻辑命名空间，物理配置目录由 VaultPort 按 Vault.configDir 映射；不得为了消除规则警告更改密文路径身份或同步格式。预审结果只保存在忽略目录，不提交历史报告。

后续仍需完成 0.1.0 普通库接入的 Mac/iPhone 安装与恢复验证，复核网络/隐私披露、安全存储和内部 iOS 桥接兼容性，并保持初始版本限制披露。联合备份还原、安全审查和其他平台尚未完成，不宣传已通过。插件只连接用户配置的自建同步服务，无分析统计、广告或自动更新器。
