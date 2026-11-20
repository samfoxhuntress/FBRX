#!/usr/bin/env bash
# Fails when a Linux package FBRX built installs a file or folder that anyone but its owner may write to (a .deb from
# 2.3.2 installed Electron's own files world-writable). Usage: scripts/check-linux-packages.sh <folder with .deb files>
set -euo pipefail
dir="${1:?the folder with the .deb packages}"
shopt -s nullglob
debs=("$dir"/*.deb)
[ ${#debs[@]} -gt 0 ] || { echo "No .deb packages in $dir" >&2; exit 1; }
bad=0
for deb in "${debs[@]}"; do
  # Mode letters: group write is the 6th character, others' write the 9th; links do not count.
  writable=$(dpkg-deb -c "$deb" | awk '$1 !~ /^l/ && (substr($1, 6, 1) == "w" || substr($1, 9, 1) == "w")')
  if [ -n "$writable" ]; then
    echo "::error::$(basename "$deb") installs $(printf '%s\n' "$writable" | wc -l) files or folders that others may write to:"
    printf '%s\n' "$writable" | head -20
    bad=1
  else
    echo "$(basename "$deb"): no group- or world-writable files"
  fi
done
exit "$bad"
