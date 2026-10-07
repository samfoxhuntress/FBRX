#!/usr/bin/env bash
# Builds the FBRX Server bundle: FBRX Virtual (server + web console), the FBRX core for the "ai" role, the installer
# and the fbrx-server command. The work is done by bundle.mjs, which also runs on macOS and Windows.
#   scripts/server/bundle.sh               → dist/fbrx-server-<version>.tar.gz
#   scripts/server/bundle.sh --with-node   also packs Node.js (for the ISO, which installs without reaching nodejs.org)
#   scripts/server/bundle.sh --skip-build  uses the FBRX Virtual build already in apps/virtual/dist
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bundle.mjs" "$@"
