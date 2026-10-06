#!/usr/bin/env bash
# Builds the FBRX Server installer ISO: Debian 13's network installer with FBRX Server added. Booting it offers
# "Install FBRX Server", which installs Debian the FBRX way (it asks which disk to wipe, and the passwords) and then
# FBRX Virtual. Needs xorriso, curl and the bundle from bundle.sh --with-node.
#
#   scripts/server/build-iso.sh                                  downloads the current Debian 13 netinst (checked)
#   scripts/server/build-iso.sh --iso debian-13.x.y-amd64-netinst.iso
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ISO=""
BUNDLE=""
OUT=""
MIRROR="https://cdimage.debian.org/debian-cd/current/amd64/iso-cd"

while [ $# -gt 0 ]; do
  case "$1" in
    --iso) ISO="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
done
command -v xorriso >/dev/null || { echo "xorriso is needed (apt install xorriso)" >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/apps/virtual/package.json').version")"
[ -n "$BUNDLE" ] || BUNDLE="$ROOT/dist/fbrx-server-$VERSION"
[ -f "$BUNDLE/fbrx-virtual/server.mjs" ] || { echo "No bundle at $BUNDLE: run scripts/server/bundle.sh --with-node first" >&2; exit 1; }
[ -n "$OUT" ] || OUT="$ROOT/dist/fbrx-server-$VERSION-amd64.iso"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -z "$ISO" ]; then
  echo "Finding the current Debian 13 network installer"
  curl -fsSL "$MIRROR/SHA256SUMS" -o "$WORK/SHA256SUMS"
  NAME="$(grep -oE 'debian-13\.[0-9.]+-amd64-netinst\.iso' "$WORK/SHA256SUMS" | head -1)"
  [ -n "$NAME" ] || { echo "No Debian 13 netinst listed at $MIRROR" >&2; exit 1; }
  ISO="$ROOT/dist/$NAME"
  if [ ! -f "$ISO" ]; then
    echo "Downloading $NAME"
    curl -fL --progress-bar "$MIRROR/$NAME" -o "$ISO.part"
    mv "$ISO.part" "$ISO"
  fi
  (cd "$(dirname "$ISO")" && grep " $NAME\$" "$WORK/SHA256SUMS" | sha256sum -c --quiet) || { echo "$NAME does not match Debian's checksum" >&2; rm -f "$ISO"; exit 1; }
fi
[ -f "$ISO" ] || { echo "No ISO at $ISO" >&2; exit 1; }

echo "Reading the installer's boot menus"
for f in /isolinux/txt.cfg /isolinux/gtk.cfg /boot/grub/grub.cfg /md5sum.txt; do
  xorriso -osirrox on -indev "$ISO" -extract "$f" "$WORK/$(basename "$f")" >/dev/null 2>&1 || true
done
[ -f "$WORK/grub.cfg" ] || { echo "$ISO does not look like a Debian installer (no /boot/grub/grub.cfg)" >&2; exit 1; }
chmod u+w "$WORK"/*

ARGS="auto=true priority=high locale=en_US.UTF-8 keymap=us preseed/file=/cdrom/fbrx/preseed.cfg"
LABEL="Install FBRX Server (erases the disk you choose)"

# BIOS boot menu (isolinux): FBRX Server is the highlighted entry (the graphical installer gives up its claim).
if [ -f "$WORK/txt.cfg" ]; then
  { printf 'label fbrx\n\tmenu label ^%s\n\tmenu default\n\tkernel /install.amd/vmlinuz\n\tappend vga=788 initrd=/install.amd/initrd.gz %s --- quiet\n' "$LABEL" "$ARGS"; sed -e '/menu default/d' "$WORK/txt.cfg"; } >"$WORK/txt.new"
fi
[ -f "$WORK/gtk.cfg" ] && sed -e '/menu default/d' "$WORK/gtk.cfg" >"$WORK/gtk.new"
# UEFI boot menu (GRUB): the same entry, first, picked after 10 seconds.
awk -v label="$LABEL" -v args="$ARGS" '
  !done && /^menuentry/ {
    print "set default=0"
    print "set timeout=10"
    print "menuentry --hotkey=f \x27" label "\x27 {"
    print "    set background_color=black"
    print "    linux    /install.amd/vmlinuz vga=788 " args " --- quiet"
    print "    initrd   /install.amd/initrd.gz"
    print "}"
    done = 1
  }
  { print }
' "$WORK/grub.cfg" >"$WORK/grub.new"
grep -q "FBRX Server" "$WORK/grub.new" || { echo "Could not add FBRX Server to the GRUB menu" >&2; exit 1; }

mkdir -p "$WORK/fbrx"
cp -r "$BUNDLE/." "$WORK/fbrx/"
cp "$ROOT/scripts/server/preseed.cfg" "$WORK/fbrx/preseed.cfg"

# The installer's "check the CD" step compares files with md5sum.txt.
if [ -f "$WORK/md5sum.txt" ]; then
  grep -vE '\./(isolinux/(txt|gtk)\.cfg|boot/grub/grub\.cfg|fbrx/)' "$WORK/md5sum.txt" >"$WORK/md5sum.new" || true
  [ -f "$WORK/txt.new" ] && (cd "$WORK" && echo "$(md5sum <txt.new | cut -d' ' -f1)  ./isolinux/txt.cfg" >>md5sum.new)
  [ -f "$WORK/gtk.new" ] && (cd "$WORK" && echo "$(md5sum <gtk.new | cut -d' ' -f1)  ./isolinux/gtk.cfg" >>md5sum.new)
  (cd "$WORK" && echo "$(md5sum <grub.new | cut -d' ' -f1)  ./boot/grub/grub.cfg" >>md5sum.new)
  (cd "$WORK" && find fbrx -type f -exec md5sum {} + | sed 's#  fbrx/#  ./fbrx/#' >>md5sum.new)
fi

echo "Writing $OUT"
MAPS=(-map "$WORK/fbrx" /fbrx -map "$WORK/grub.new" /boot/grub/grub.cfg)
[ -f "$WORK/txt.new" ] && MAPS+=(-map "$WORK/txt.new" /isolinux/txt.cfg)
[ -f "$WORK/gtk.new" ] && MAPS+=(-map "$WORK/gtk.new" /isolinux/gtk.cfg)
[ -f "$WORK/md5sum.new" ] && MAPS+=(-map "$WORK/md5sum.new" /md5sum.txt)
rm -f "$OUT"
xorriso -indev "$ISO" -outdev "$OUT" -volid "FBRX_SERVER_${VERSION//./_}" "${MAPS[@]}" -boot_image any replay >/dev/null 2>&1 || {
  xorriso -indev "$ISO" -outdev "$OUT" -volid "FBRX_SERVER_${VERSION//./_}" "${MAPS[@]}" -boot_image any replay
  exit 1
}
(cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" >"$(basename "$OUT").sha256")
echo "Built $OUT ($(du -h "$OUT" | cut -f1)). Write it to a USB stick (or mount it through the iDRAC virtual console) and boot from it."
