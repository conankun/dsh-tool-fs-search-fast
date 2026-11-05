# Legacy: `app.asar` surgery (retired)

> **Retired.** This document describes the first install mechanism, which rewrote
> the Electron `app.asar` in place. The fork is now a normal DSH **profile bundle
> package**: it is installed into `~/.dsh/profiles/<profile>`, the plugin does
> **not** live inside the app bundle, and nothing in the app archive is touched.
> See [../README.md](../README.md) for the current install.
>
> The material below is kept because `tools/install.mjs` / `tools/uninstall.mjs`
> still exist for an app build that cannot load profile packages, and because the
> archive mechanics were verified against real archives.

## Why it is retired

- An app update replaces `app.asar`, silently dropping the fork — the profile
  install survives updates because `~/.dsh` is outside the bundle.
- Rewriting a 222 MB signed archive in place is a byte-level procedure with no
  bearing on how the plugin works; the plugin API does not require it.
- The profile install needs no archive surgery, is versioned by `package.json`
  (`git+ssh://…/dsh-tool-fs-search.git#main`), and is inspectable with
  `dsh --profile <p> --dump-config`.

## Archive layout (Chromium Pickle)

| offset | type | meaning |
| --- | --- | --- |
| 0 | u32 LE | `4` — size-pickle payload length |
| 4 | u32 LE | `headerPickleSize`; `dataStart = 8 + headerPickleSize` |
| 8 | u32 LE | `payloadSize = jsonLen + 4 + pad` |
| 12 | u32 LE | `jsonLen` |
| 16 | bytes | header JSON (UTF-8), then `0..3` zero pad bytes to a 4-byte boundary |
| `dataStart` | bytes | file data region; entry `offset` values are relative to it |

`tools/asar-pack.mjs --selftest` parses the header, rebuilds it with
`JSON.stringify` and proves the result is **byte-identical** (same size, same
bytes, same sha256) to the input. That is the gate for every writer change.

## Replacement strategy (historical)

1. Keep the original data region untouched.
2. **Append** the replacement file bytes at the end of the data region and
   repoint that entry's `offset`/`size`. Dead original bytes stay behind
   (the live archive already carried ~10 MB of such gaps from an earlier hand
   repack, so gaps are normal).
3. Strip `integrity` for the replaced entry only (its hash is stale); every
   untouched entry keeps its own integrity record.
4. **Keep the header JSON byte length identical** (pad the JSON text with
   trailing spaces, which `JSON.parse` ignores). With `jsonLen` unchanged the
   `dataStart` — and therefore every untouched entry's absolute position — is
   unchanged too, so a running DSH process keeps reading untouched files at the
   same offsets; only the replaced plugin entry moved.
5. Refuse `unpacked` entries (they have a `size` but no `offset`; their bytes
   live in `app.asar.unpacked/`).

## Install pipeline (`tools/install.mjs`)

1. Back up the pristine archive once: `app.asar.bak-fast-<ts>` + `.sha256`
   sidecar. Later re-installs reuse **that** backup as the source, so the
   operation is idempotent and the header length stays the original one.
2. Build the new archive next to it as `app.asar.fast.tmp`.
3. Validate before swapping: entry count unchanged, replaced entry bytes equal
   the local `lib/index.js`, three untouched spot entries hash-unchanged, temp
   file size as expected.
4. Atomic `rename` over the live archive.
5. Probe Electron: `ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/DeepSeek Harness" -e 'import("file://…/app.asar/dsh/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js")'`
   must report `EXPORTS=38 TOOL=tool-fs-search`. On failure the backup is copied
   back automatically.

## Activation and rollback

The plugin module is imported when DSH composes its agent tree, so an already
running DSH keeps the old module until it is restarted.

```bash
node tools/uninstall.mjs          # restore the first backup, sha256-verified
```

The backup is kept after a restore, so re-installing does not need another
222 MB copy.

## Update story (the reason this is legacy)

A DSH app update replaces the bundle and therefore drops this fork; re-running
`node tools/install.mjs` after every update is the only way to keep it. The
profile bundle install has no such step.

Do not touch `Contents/Info.plist`: the bundle is already ad-hoc signed and its
sealed-resource seal is broken, but the Info.plist hash is not something we need
to (or should) change.
