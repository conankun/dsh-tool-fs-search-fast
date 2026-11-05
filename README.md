# @yuna/dsh-tool-fs-search-fast

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![glob ~40x faster](https://img.shields.io/badge/glob-~40x%20faster-blue.svg)](#how-much-faster)

Fast fork of DeepSeek Harness's `@deepseek-ai/dsh-tool-fs-search` — the plugin that
provides the model-facing `glob` and `grep` tools. Same tool names, same schemas,
same result contract; a much faster engine underneath.

The published package ships only a compiled `lib/index.js`, so this repo forks
that bundle directly and documents every change against it
(`docs/upstream-README.md`, `docs/upstream-package.json` are the untouched
upstream copies).

**English** · [한국어](README.ko.md)

> **Install path: a profile bundle package.** The fork is a normal DSH plugin
> package; it lives in `~/.dsh/profiles/<profile>`, never inside the Electron
> `app.asar`. Rewriting `app.asar` is retired — see [docs/ASAR.md](docs/ASAR.md)
> for the legacy mechanism and why it is no longer used.

## How much faster

Measured end-to-end through the DSH tools themselves, 18-core Apple Silicon, warm cache:

- `glob **/*.ts` over a 1.16 M-file tree: **7.25 s → 0.18 s** (~40×)
- `grep import` over the same tree: **1.26 s then `SEARCH_RAW_OUTPUT_OVERFLOW` → 50 ms**, 250 matches
- `glob **/*.ts` over a 62 k-file repo: **0.70 s → 0.13 s** (~5×)
- fixed shim overhead vs the stock binary on a 2-file tree: **+4–6 ms**
- nothing to prune, 1.34 M files (search root inside an excluded dir): **4.1 s → 1.6 s** (~2.6×)

Likewise on a many-core host (AMD EPYC 9965, 768 threads, Node 22, rg 14.1.1, warm cache):

| case | upstream | this fork | |
| --- | --- | --- | --- |
| `glob **/*.ts`, 1.18 M files (98% under `node_modules`) | 2 633 ms | **78 ms** | 34× |
| `glob **/*`, 1.34 M files, pruning disabled | 4 144 ms | **1 564 ms** | 2.6× |
| `grep import`, 982 k files | 883 ms, 615 MB collected | **36 ms**, 250 matches | 25× |
| `grep a`, 982 k files | 18 816 ms, 35 GB collected | **674 ms**, 250 matches | 28× |

Two argv/pipeline decisions in the upstream plugin dominate latency:

| upstream | problem |
| --- | --- |
| `rg --files --glob=<p> --sort=modified --no-ignore --hidden` | `--sort=modified` forces ripgrep to run **single-threaded** and to stat every visited file in that one thread; `--no-ignore` walks `node_modules` and friends |
| `rg --json …` collected **completely**, then truncated to the first N matches | a broad pattern on a large tree exceeds the 20 MB raw-output cap and hard-fails with `SEARCH_RAW_OUTPUT_OVERFLOW` before any result is shown |

Measured on an 18-core Apple Silicon machine (warm cache):

| call | upstream | this fork | speedup |
| --- | --- | --- | --- |
| `glob **/*.ts` over a 1.16M-file tree (95% under artifact dirs) | 7252 ms | ~180 ms | **~40×** |
| `grep import` over the same tree | 1.26 s, then overflow error | ~50 ms, 250 matches | **~25×** |
| `glob **/*.ts` over a 62k-file repo | ~700 ms | ~130 ms | **~5×** |

## What changed in `lib/index.js`

1. `buildGlobCommand`: `--sort=modified` removed, `--threads=0` added, and
   configurable build-artifact directories (`globExcludeDirs`, default
   `node_modules .venv venv __pycache__ .next .nuxt .turbo .cache Pods .gradle
   target`) are appended **after** the caller's `--glob` pattern — ripgrep is
   last-match-wins, so order matters and prepending them would make pruning
   inert for broad patterns.
2. New `sortPathsByMtime`: the documented "modification-time order" the old
   single-threaded sort produced (mtime **ascending**, the exact semantics of
   `rg --sort=modified`) is restored afterwards at **nanosecond** precision with
   a stable sort. The stat fan-out runs on **worker threads** (`fs.statSync`
   inside a worker is not limited by the main thread's libuv pool, which is only
   4 concurrent syscalls by default); below 8 192 paths it stays inline.
3. New `isInsideExcludedDir`: an explicit `path` that already sits inside a
   pruned directory disables pruning for that call, so deliberate searches
   there still work.
4. New `runRipgrepStreaming`: `grep` now forwards the NDJSON stream and
   terminates ripgrep at the match cap, instead of collecting the whole stream
   through the subprocess seam. The output is an exact prefix of the full run
   (validated record-for-record), so the first-N contract is unchanged.
5. `Config` gained `globExcludeDirs`; the glob tool description now states the
   pruning behaviour. Everything else (schemas, retention, spill, presentation,
   error vocabulary, exit-code handling) is upstream code, untouched.

## Install as a profile bundle package

The package is a DSH **bundle**: `package.json` carries
`dsh.bundle.patch` and the bundle layer (`cordis.patch.yml`) inserts the fast
row. Everything the plugin needs at runtime — `@deepseek-ai/*` peers and
`@vscode/ripgrep` — is a **peer dependency**, so the profile runtime resolves
them from the DSH installation: nothing is downloaded and the fork always uses
the ripgrep binary the app shipped.

### What the profile looks like

```
~/.dsh/profiles/<profile>/
  package.json
    dependencies["@yuna/dsh-tool-fs-search-fast"] =
      "git+https://github.com/conankun/dsh-tool-fs-search-fast.git#main"
    dsh.profile.bundles += "@yuna/dsh-tool-fs-search-fast"
  cordis.patch.yml
    - id: tool-fs-search
      name: '@deepseek-ai/dsh-tool-fs-search'
      disabled: true                     # exactly one glob/grep provider
  node_modules/@yuna/dsh-tool-fs-search-fast/   installed by pnpm
```

### Steps

1. Install the package into the profile:
   `pnpm add "git+https://github.com/conankun/dsh-tool-fs-search-fast.git#main"`
   (a `file:` dependency on a local checkout works the same way for development).
2. Append `"@yuna/dsh-tool-fs-search-fast"` to `dsh.profile.bundles` — after
   `@deepseek-ai/dsh-base`, so the stock row exists before the profile layer
   disables it.
3. Add the `disabled: true` row above to the profile's `cordis.patch.yml`.
4. Restart DSH: the plugin tree is composed at boot.

Check the composition without booting:

```
dsh --profile <profile> --dump-config | grep -A3 tool-fs-search
# == @yuna/dsh-tool-fs-search-fast   <- inserted
# - id: tool-fs-search                  <- stock row, disabled: true
```

### The Electron-managed profile

`dsh plugin --profile desktop …` is refused ("profile desktop is managed
exclusively by the Electron application"). Edit the desktop profile's
`package.json` and `cordis.patch.yml` directly as above, then restart the app.

### App updates

The install lives in `~/.dsh`, which an app update does not touch, so the fork
**survives a DeepSeek Harness update** — unlike the retired `app.asar` patch,
which an update wipes. What can change is the plugin API: the peers are pinned
to the app version the fork was written against, so after a DSH release run
`pnpm update @yuna/dsh-tool-fs-search-fast` (or bump `#main`) and
`npm test` against the new app.

## Config

The entry's config is patched in the profile layer (bundle defaults come from
`cordis.patch.yml` in this repo):

```yaml
- id: tool-fs-search-fast
  config:
    sampleOverCapGlobResults: false
    globExcludeDirs: []        # [] = exact upstream glob semantics (no pruning)
```

Defaults: artifact-directory pruning on, grep stops at 250 matches. A `disabled:
true` row for the stock `tool-fs-search` keeps exactly one provider of the
`glob`/`grep` tool names.

## Validation

- `node --check lib/index.js` on every change.
- `npm test` (`test/sandbox.sh`) runs `test/run.mjs` against stub peer packages —
  offline, no app install needed (this is what CI runs).
- `npm run test:app` runs the same suite through Electron-as-node against a real
  `app.asar`, which exercises the real peer dependency versions.
- Parity against `rg.real`: identical path sets; byte-identical order except
  files with exactly equal nanosecond mtimes (ripgrep's own tie order is
  unstable).
- Profile install verified with a real boot: corrupting the profile copy of
  `lib/index.js` makes DSH fail with `failed to import` on that path — proof the
  profile package (not the app bundle) is what loads.

## Legacy: in-place `app.asar` fork

`tools/install.mjs` swaps the app bundle's `@deepseek-ai/dsh-tool-fs-search`
with this fork (original kept as `app.asar.bak-fast-<ts>`, restored byte-for-byte
by `tools/uninstall.mjs`). It is retired: an app update wipes it, and the bundle
install above needs no archive surgery. The tooling is kept for an app build that
cannot load profile packages; see [docs/ASAR.md](docs/ASAR.md).

## License

MIT — inherited from the upstream package. See [LICENSE](LICENSE).
