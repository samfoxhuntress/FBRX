#!/bin/bash
# FBRX Command installer for macOS (and Linux). Double-click this file in Finder, or run:
#   bash "Install FBRX Command.command"            (add --local, --port, --uninstall… see scripts/setup/command.mjs)
# FBRX Command runs your company's, school's or family's FBRX computers from your browser. This uses the same
# Node.js bootstrap as "Install FBRX OS.command" (a private copy in .fbrx-setup/ when needed), then runs
# scripts/setup/command.mjs.
cd "$(dirname "$0")" || exit 1
export FBRX_SETUP_SCRIPT=scripts/setup/command.mjs
exec bash "./Install FBRX OS.command" "$@"
