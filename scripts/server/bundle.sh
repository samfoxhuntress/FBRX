#!/usr/bin/env bash
# Builds the FBRX Server bundle: FBRX Virtual (server + web console), its installer and the fbrx-server command.
#   scripts/server/bundle.sh               → dist/fbrx-server-<version>.tar.gz
#   scripts/server/bundle.sh --with-node   also packs Node.js (for the ISO, which installs without reaching nodejs.org)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WITH_NODE=0
SKIP_BUILD=0
for a in "$@"; do
  case "$a" in
    --with-node) WITH_NODE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "Unknown option $a" >&2; exit 1 ;;
  esac
done

VERSION="$(node -p "require('$ROOT/apps/virtual/package.json').version")"
NAME="fbrx-server-$VERSION"
OUT="$ROOT/dist/$NAME"

if [ "$SKIP_BUILD" -eq 0 ]; then
  (cd "$ROOT" && npm run build -w @fbrx/virtual-console && npm run build -w @fbrx/virtual)
fi
if [ ! -f "$ROOT/apps/virtual/dist/server.mjs" ] || [ ! -f "$ROOT/apps/virtual/dist/virtual-console/index.html" ]; then
  echo "Build FBRX Virtual and its console first" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/fbrx-virtual"
cp "$ROOT/apps/virtual/dist/server.mjs" "$ROOT/apps/virtual/dist/cli.mjs" "$ROOT/apps/virtual/dist/package.json" "$OUT/fbrx-virtual/"
cp -r "$ROOT/apps/virtual/dist/virtual-console" "$OUT/fbrx-virtual/virtual-console"
find "$OUT/fbrx-virtual/virtual-console" -name '*.map' -delete
cp "$ROOT/scripts/server/install.sh" "$ROOT/scripts/server/fbrx-server" "$ROOT/scripts/server/fbrx-virtual.service" "$OUT/"
chmod +x "$OUT/install.sh" "$OUT/fbrx-server"
echo "$VERSION" >"$OUT/VERSION"

if [ "$WITH_NODE" -eq 1 ]; then
  BASE="https://nodejs.org/dist/latest-v22.x"
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")"
  NODE="$(grep -oE 'node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' <<<"$SUMS" | head -1)"
  curl -fsSL "$BASE/$NODE" -o "$OUT/$NODE"
  grep " $NODE\$" <<<"$SUMS" >"$OUT/$NODE.sha256"
  (cd "$OUT" && sha256sum -c --quiet "$NODE.sha256")
  echo "Packed $NODE"
fi

tar -C "$ROOT/dist" -czf "$ROOT/dist/$NAME.tar.gz" "$NAME"
echo "Built dist/$NAME.tar.gz ($(du -h "$ROOT/dist/$NAME.tar.gz" | cut -f1))"
