# xSync

English | [简体中文](README.zh-CN.md)

Sync an Obsidian vault between your devices with a self-hosted server and end-to-end encryption. Conflicting edits stay available for explicit review; xSync never selects a winner by timestamp, upload order, or device priority.

[Install xSync](https://community.obsidian.md/plugins/xsync) · [Server setup](docs/DEPLOYMENT.md) · [Installation guide](docs/SETUP.md)

Free and open source. You need your own HTTPS server. The plugin interface and detailed guides are currently in Chinese.

## Features

- Sync notes, attachments, and shareable configuration with end-to-end encryption.
- Compare conflicting edits, select a version, keep both, merge text manually, or postpone the decision while other files continue syncing.
- Set file-size, folder, extension, and regular-expression exclusions independently on each device.
- Pause and resume with your saved key. Persistent queues recover interrupted work and catch up when the app returns to the foreground.

## Quick start

The following flow is implemented in the **unreleased source**, for fresh PostgreSQL deployments and new vaults. Build both server and plugin from this revision; published 0.1.2 assets use the previous enrollment flow.

1. Follow [server setup](docs/DEPLOYMENT.md). Set the administrator password and open `/admin/`; no vault initialization bundle is required.
2. Create a user and save their access key, which is shown only once. The key authorizes server access and can be rotated or disabled.
3. Install the plugin built from this source. Enter the server address and access key, then create a vault with your own encryption password or unlock an existing vault. Encryption passwords stay on your devices.

See [installation](docs/SETUP.md). Each user can own multiple independent vaults. Space accounting, quotas, SQLite and legacy-vault migration are outside this change.

## Compatibility and limits

- The minimum Obsidian version is **1.14.4**. Target platforms are macOS and iOS; Android secure storage is not implemented, and Windows/Linux lack physical-device validation. The iOS adapter uses an internal native host bridge that needs validation for each supported host version.
- The server supports **PostgreSQL**. SQLite is not implemented.
- Foreground sync and catch-up after returning to the app are supported. Continuous background or locked-screen execution is not guaranteed. Source files are read as whole files even though transfers are chunked.
- Sync covers current files and unresolved conflicts. There is no version-history or recycle-bin interface.
- Use an independent test vault and keep backups. Admin, enrollment and sync flows were checked in two native Obsidian test vaults on one Mac. Separate physical devices, iPhone, production backup restoration, key migration, large-file resource use, and a production security review still need validation.

The source tree contains unreleased protocol changes. Build the plugin and server from the same revision for development; do not pair the released 0.1.2 plugin with the current source server. See [upgrade requirements](docs/DEPLOYMENT.md#源码升级与协议兼容).

## Privacy

The plugin connects to the server you configure. Contents, paths, and shareable configuration snapshots are encrypted. User labels, vault display names, device names, file identities, sizes, and synchronization metadata remain visible to the server. The server receives the access key for authorization over HTTPS, stores only its digest, and never receives vault encryption passwords or content-decryption keys. Local credentials use operating-system protection without a plaintext fallback.

There is no analytics, advertising, or plugin self-updater. Device credentials, workspace layouts, the core-plugin enable list, and xSync's own files stay local. Unknown secret fields in other plugins' settings may require explicit exclusion.

## Development and documentation

Requires Node.js >=22.12:

```sh
npm ci
npm run check
```

For Go/PostgreSQL integration and recovery tests, see the [contribution guide](CONTRIBUTING.md) and [development workflow](docs/testing/DEVELOPMENT.md).

- [Documentation index](docs/README.md)
- [Installation](docs/SETUP.md) and [deployment](docs/DEPLOYMENT.md)
- [Protocol reference](protocol/README.md)
- [Release process](docs/RELEASING.md) and [changelog](CHANGELOG.md)

## License

[MIT](LICENSE). Upstream template and dependency notices are retained in [plugin/licenses](plugin/licenses); see [template attribution](plugin/TEMPLATE.md).
