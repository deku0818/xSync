# xSync

English | [简体中文](README.zh-CN.md)

Sync an Obsidian vault between your devices with a self-hosted server and end-to-end encryption. Share one server with friends: each user has their own access key and vaults, and the server cannot decrypt vault contents.

[Install xSync](https://community.obsidian.md/plugins/xsync) · [Server setup](docs/DEPLOYMENT.md) · [Installation guide](docs/SETUP.md)

Free and open source. Both the plugin and admin page support English and Simplified Chinese.

## Features

- Multiple users: create separate accounts for yourself and friends, each with their own access key and vaults.
- End-to-end encryption: sync notes, attachments, and shareable configuration without letting the server decrypt them.
- Compare conflicting edits, select a version, keep both, merge text manually, or postpone the decision while other files continue syncing.
- Set file-size, folder, extension, and regular-expression exclusions independently on each device.
- Pause and resume with your saved key. Persistent queues recover interrupted work and catch up when the app returns to the foreground.

## Quick start

1. **Deploy the server** using [`ycw0818/xsync-server`](https://hub.docker.com/r/ycw0818/xsync-server) from Docker Hub. Follow the [deployment guide](docs/DEPLOYMENT.md).
2. **Create a user** in the admin page and save their access key.
3. **Connect Obsidian**: install xSync, enter the server address and access key, then create or join a vault. See the [connection guide](docs/SETUP.md).

## Requirements

- Obsidian **1.14.4 or later**. Android credential-storage integration and device testing are pending.
- The server currently uses PostgreSQL; SQLite support is in development.
- Sync runs in the foreground and catches up when you return. Continuous background or locked-screen sync is not guaranteed.
- Current files and unresolved conflicts are retained. There is no version-history or recycle-bin interface. Back up your vault before first use.

## Privacy

The plugin connects to the server you configure. Contents, paths, and shareable configuration snapshots are encrypted. User labels, vault display names, device names, file identities, sizes, and synchronization metadata remain visible to the server. The server receives the access key for authorization, stores only its digest, and never receives vault encryption passwords or content-decryption keys. Local credentials use operating-system protection without a plaintext fallback.

There is no analytics, advertising, or plugin self-updater. Device credentials, workspace layouts, the core-plugin enable list, and xSync's own files stay local. Unknown secret fields in other plugins' settings may require explicit exclusion.

## Development and documentation

See the [contributing guide](CONTRIBUTING.md) for development and tests.

For Go/PostgreSQL integration and recovery tests, see the [contribution guide](CONTRIBUTING.md) and [development workflow](docs/testing/DEVELOPMENT.md).

- [Documentation index](docs/README.md)
- [Installation](docs/SETUP.md) and [deployment](docs/DEPLOYMENT.md)
- [Protocol reference](protocol/README.md)
- [Release process](docs/RELEASING.md) and [changelog](CHANGELOG.md)

## License

[MIT](LICENSE). Upstream template and dependency notices are retained in [plugin/licenses](plugin/licenses); see [template attribution](plugin/TEMPLATE.md).
