# xSync 发布准备

正式名称 **xSync**，ID **xsync**，仓库为 `deku0818/xSync`。根目录 `manifest.json` 是同步插件的唯一 manifest 来源；探针使用独立的 `plugin/manifest.json`。`versions.json` 记录各插件版本的最低宿主要求，须与 manifest 一致。

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
- 当前 `manifest.json` 的准确版本：手动构建该版本的服务端镜像，不更新 `latest`；源码以运行记录、完整 `sha-<commit>` 标签和 OCI revision 为准。
- 后续发布 GitHub Release 时自动构建该 Release 的准确提交；tag 必须与 manifest 版本相同且不加 `v`。正式 Release 上传版本标签和 `latest`；prerelease 不更新 `latest`。

所有上传均额外生成完整 `sha-<commit>` 标签，Actions 摘要记录镜像 digest。版本标签可被重新运行覆盖；部署需要固定内容时使用 `ycw0818/xsync-server@sha256:<digest>`。不要通过补发旧的正式 Release 更新 `latest`，否则它会指向旧版本。

上传前复用 `check.yml` 的完整验证，包括数据库合同/race、浏览器恢复，以及两种架构镜像的构建和入口冒烟检查；任何检查失败均不上传。普通 push/PR 只检查，不登录 Docker Hub、不推送镜像。首次补发旧版本应使用包含新 CI 的分支手动运行，不能对缺少工作流/Dockerfile 的旧 tag 直接运行。新 Release 对应的提交必须包含这些文件。

镜像运行与持久化方式见[部署说明](DEPLOYMENT.md#使用服务端镜像)。工作流成功不代表部署或真机验收完成。

## 插件发布流程

1. 确认目标版本，更新 manifest、最低宿主映射与更新记录。tag 与 manifest 版本完全一致，不加 `v`；不改写已发布 tag 或资产。
2. 在目标提交运行常规 CI 和官方预审，检查阻断问题。需要说明的扫描结果应对照源码解释，不通过隐藏依赖代码或改变同步语义消除提示。
3. 对同一提交运行 **Prepare xSync package**，下载原始产物，核对 manifest、`SHA256SUMS` 和三个安装文件的来源证明。
4. 发布 GitHub Release，只附 `main.js`、`manifest.json` 和 `styles.css`；原样使用已核验文件，不重新构建或修改。ZIP 和校验和保留在本地与 Actions 产物，许可已嵌入 `main.js`。
5. 在社区管理入口触发新版本检查，分别核对 GitHub Release、社区扫描和展示版本，不能把扫描 Pending 写成通过。

在下载目录验证来源：

```sh
gh attestation verify main.js --repo deku0818/xSync
gh attestation verify manifest.json --repo deku0818/xSync
gh attestation verify styles.css --repo deku0818/xSync
```

首次提交社区目录时，按 [Obsidian 官方提交流程](https://docs.obsidian.md/plugins/releasing/submit-plugin) 准备 README、许可和 manifest，命名要求见 [Manifest 文档](https://docs.obsidian.md/Reference/Manifest)。

## 发布说明

发布说明应写清用户可见变化、升级要求与已完成的验证。当前源码含尚未发布的协议变更，插件与服务端必须配套，见[升级兼容说明](DEPLOYMENT.md#源码升级与协议兼容)。

平台、安全存储、网络/隐私披露和生产备份限制见[安装说明](SETUP.md)。自动检查、来源证明和构建复现不能替代原生设备与生产安全验收。扫描报告、逐次发布操作和私有运维记录不提交到代码仓库。
