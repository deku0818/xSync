# Automated review context

These notes explain behavior visible to reviewers. They do not override the
directory's checks or claim a security audit has been completed.

## Configuration namespace

`plugin/src/sync/config-path.ts` defines `SHARED_CONFIG_ROOT = ".obsidian"` as
the existing **wire protocol namespace**, not a physical filesystem path.
`ObsidianVaultPort.logical()` maps the actual `Vault.configDir` to this namespace;
`physical()` performs the reverse mapping before configuration I/O. Ordinary
notes use the Vault API. The core does not assume that a device's configuration
folder is named `.obsidian`.

The namespace participates in authenticated encrypted path identities, path
indexes, configuration projection and fixed exclusions. Replacing it with each
device's local folder name would break interoperability between devices that
use different configuration directories. Version 0.1.1 centralizes the existing
constant and removes magic prefix lengths; it does not migrate paths or change
the encrypted format. See `tests/desktop/core.test.ts` and
`tests/desktop/engine.integration.test.ts` for custom-directory coverage.

## RE2JS method named eval

The pinned `re2js` dependency provides `Prefilter.eval(input, pos)` and calls
`this.subs[i].eval(...)` / `this.prefilter.eval(...)`. This method evaluates a
regular-expression prefilter tree; it is not JavaScript's global `eval` and
does not compile or execute JavaScript supplied by users. See the dependency's
[`src/Prefilter.js`](https://github.com/le0pard/re2js/blob/2.8.6/src/Prefilter.js)
and the readable RE2JS section of the bundled `main.js`.

xSync uses RE2JS for per-device exclusion rules. The release build is readable,
does not rename this method to hide it from scanners, and does not load code from
the sync server. A heuristic that matches every method named `eval` can report
dynamic execution here; this finding needs context-aware review.

## Vault enumeration and other disclosures

Whole-vault synchronization needs the file inventory to discover local changes,
new files and deletions. Paths are filtered by fixed device-local exclusions and
the user's independent rules. The inventory is not sent as plaintext to an
analytics service. Network calls target the user's self-hosted server; contents,
paths and shareable configuration snapshots are encrypted. Device names,
identities, sizes and synchronization metadata remain visible to that server.

libsodium's WASM memory export and dependency transpilation helpers are build
disclosures, not proof of a vulnerability. Automated scans and reproducible builds
do not replace the outstanding native-device and production security validation
described in [SETUP.md](SETUP.md).

## Release provenance and installation files

The manual `Prepare xSync package` workflow builds and attests the exact
`main.js`, `manifest.json` and `styles.css` files. These are the only assets
attached to community releases from 0.1.1 onward. The local/Actions ZIP remains
available for development; it is not an extra community release asset. License
and dependency notices are embedded in `main.js`, so normal community installs
retain them without downloading unsupported extra files.

Verify downloaded files with:

```sh
gh attestation verify main.js --repo deku0818/xSync
gh attestation verify manifest.json --repo deku0818/xSync
gh attestation verify styles.css --repo deku0818/xSync
```
