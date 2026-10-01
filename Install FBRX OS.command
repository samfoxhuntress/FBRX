#!/bin/bash
# FBRX OS installer for macOS (and Linux). Double-click this file in Finder, or run:  bash "Install FBRX OS.command"
# It uses your Node.js if it is new enough; otherwise it downloads a private copy into .fbrx-setup/ (nothing is
# installed system-wide), then starts the setup wizard in scripts/setup/wizard.mjs.
set -u
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "Setup could not start: $1"
  echo "Check your internet connection and double-click the installer again."
  [ -t 0 ] && [ -z "${FBRX_NO_PAUSE:-}" ] && read -r -p "Press Enter to close this window." _
  exit 1
}

# Node.js 22.15 or newer is required.
node_ok() {
  local v
  v="$("$1" --version 2>/dev/null)" || return 1
  v="${v#v}"
  local major="${v%%.*}" rest="${v#*.}"
  local minor="${rest%%.*}"
  [ "$major" -gt 22 ] 2>/dev/null || { [ "$major" -eq 22 ] && [ "$minor" -ge 15 ]; } 2>/dev/null
}

NODE=""
PRIVATE_NODE=".fbrx-setup/node/bin/node"
if [ -z "${FBRX_FORCE_PORTABLE_NODE:-}" ] && command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
elif [ -x "$PRIVATE_NODE" ] && node_ok "$PRIVATE_NODE"; then
  NODE="$PRIVATE_NODE"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLATFORM="darwin-arm64" ;;
    Darwin-x86_64) PLATFORM="darwin-x64" ;;
    Linux-x86_64) PLATFORM="linux-x64" ;;
    Linux-aarch64 | Linux-arm64) PLATFORM="linux-arm64" ;;
    *) fail "this computer type ($(uname -s) $(uname -m)) is not supported." ;;
  esac
  BASE="https://nodejs.org/dist/latest-v22.x"
  echo "Downloading Node.js for the installer (about 50 MB, used only by FBRX OS setup)..."
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")" || fail "could not reach nodejs.org."
  LINE="$(printf '%s\n' "$SUMS" | grep -E " node-v[0-9.]+-$PLATFORM\.tar\.gz$" | head -n 1)"
  [ -n "$LINE" ] || fail "no Node.js download found for $PLATFORM."
  FILE="${LINE##* }"
  SUM="${LINE%% *}"
  mkdir -p .fbrx-setup
  curl -fL --progress-bar -o ".fbrx-setup/$FILE" "$BASE/$FILE" || fail "the Node.js download failed."
  if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 ".fbrx-setup/$FILE" | cut -d' ' -f1)"; else GOT="$(sha256sum ".fbrx-setup/$FILE" | cut -d' ' -f1)"; fi
  [ "$GOT" = "$SUM" ] || { rm -f ".fbrx-setup/$FILE"; fail "the Node.js download was corrupted."; }
  rm -rf .fbrx-setup/node && mkdir -p .fbrx-setup/node
  tar -xzf ".fbrx-setup/$FILE" -C .fbrx-setup/node --strip-components 1 || fail "could not unpack Node.js."
  rm -f ".fbrx-setup/$FILE"
  NODE="$PRIVATE_NODE"
fi

"$NODE" scripts/setup/wizard.mjs "$@"
STATUS=$?
if [ -t 0 ] && [ -z "${FBRX_NO_PAUSE:-}" ]; then
  echo
  read -r -p "Press Enter to close this window." _
fi
exit $STATUS
