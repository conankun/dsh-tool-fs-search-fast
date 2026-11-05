#!/bin/bash
# Local unit sandbox: run test/run.mjs against lib/index.js with stub peer
# packages so the fast glob/grep logic can be exercised without the app bundle.
set -euo pipefail
SRC="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/pkg/lib"
cp "$SRC/lib/index.js" "$T/pkg/lib/index.js"
for stub in "$SRC"/test/stubs/*/; do
  base="$(basename "$stub")"
  case "$base" in
    vscode--ripgrep) dest="$T/pkg/node_modules/@vscode/ripgrep" ;;
    *) dest="$T/pkg/node_modules/@deepseek-ai/$base" ;;
  esac
  mkdir -p "$dest"
  cp -R "$stub/." "$dest/"
done
cd "$SRC"
node test/run.mjs "file://$T/pkg/lib/index.js"
