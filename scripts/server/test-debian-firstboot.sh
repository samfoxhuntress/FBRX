#!/usr/bin/env bash
# CI check of what the FBRX Server ISO leaves behind: a fresh Debian 13 root with the administrator account, FBRX Server
# copied to /opt/fbrx-installer and the first-start service switched on, exactly as the installer's late_command does,
# and the install disc still listed as a package source. Runs the first-start setup in it (in a chroot it installs and
# enables everything but starts nothing) and checks the result.
#
#   sudo scripts/server/test-debian-firstboot.sh dist/fbrx-server-0.1.0
set -euo pipefail

BUNDLE="$(cd "${1:?usage: $0 <unpacked FBRX Server bundle>}" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 1; }
BASE="$(mktemp -d)"
R="$BASE/trixie"
cleanup() {
  for m in dev/pts dev sys proc; do
    if mountpoint -q "$R/$m"; then umount -l "$R/$m" || true; fi
  done
  rm -rf "$BASE"
  return 0
}
trap cleanup EXIT

echo "== Debian 13 root"
debootstrap --variant=minbase --keyring=/usr/share/keyrings/debian-archive-keyring.gpg \
  --include=systemd,systemd-sysv,curl,ca-certificates,xz-utils,sudo,openssl,procps,ifupdown,grub-common \
  trixie "$R" http://deb.debian.org/debian >"$BASE/debootstrap.log" 2>&1 || { tail -30 "$BASE/debootstrap.log"; exit 1; }
mount -t proc proc "$R/proc"
mount -t sysfs sysfs "$R/sys"
mount --bind /dev "$R/dev"
mount -t devpts devpts "$R/dev/pts"
cp -L /etc/resolv.conf "$R/etc/resolv.conf"
# As the Debian installer leaves it while it runs: the disc first, then the mirror.
{ echo 'deb cdrom:[Debian GNU/Linux 13.1.0 _Trixie_ - Official amd64 NETINST]/ trixie main'; cat "$R/etc/apt/sources.list"; } >"$R/etc/apt/sources.list.new"
mv "$R/etc/apt/sources.list.new" "$R/etc/apt/sources.list"
# Daemons do not start inside a chroot (the installer does the same).
printf '#!/bin/sh\nexit 101\n' >"$R/usr/sbin/policy-rc.d"
chmod +x "$R/usr/sbin/policy-rc.d"
chroot "$R" useradd -m -u 1000 -s /bin/bash fbrx

echo "== The installer's late_command"
mkdir -p "$R/opt/fbrx-installer" "$R/etc/systemd/system/multi-user.target.wants"
cp -r "$BUNDLE/." "$R/opt/fbrx-installer/"
cp "$BUNDLE/fbrx-server-firstboot.service" "$R/etc/systemd/system/fbrx-server-firstboot.service"
ln -sf /etc/systemd/system/fbrx-server-firstboot.service "$R/etc/systemd/system/multi-user.target.wants/fbrx-server-firstboot.service"

echo "== First start: firstboot.sh"
chroot "$R" /bin/bash /opt/fbrx-installer/firstboot.sh

echo "== Checks"
fail() { echo "FAIL: $*" >&2; exit 1; }
chroot "$R" /opt/fbrx-server/node/bin/node --version || fail "Node.js is not in place"
for f in /opt/fbrx-server/fbrx-virtual/server.mjs /opt/fbrx-server/fbrx-core/core.mjs /usr/local/sbin/fbrx-server /etc/fbrx-virtual/fbrx-virtual.env /etc/fbrx-server-release; do
  [ -e "$R$f" ] || fail "$f is missing"
done
for u in fbrx-virtual fbrx-core; do
  [ -L "$R/etc/systemd/system/multi-user.target.wants/$u.service" ] || fail "$u.service is not enabled"
done
[ ! -e "$R/etc/systemd/system/multi-user.target.wants/fbrx-server-firstboot.service" ] || fail "the first-start service did not switch itself off"
[ ! -e "$R/etc/issue.d/fbrx-server-firstboot.issue" ] || fail "the login screen still says the setup did not finish"
grep -q 'Sign in here as fbrx' "$R/etc/issue" || fail "the login screen does not name the account"
chroot "$R" dpkg -s qemu-system-x86 libvirt-daemon-system swtpm-tools ovmf >/dev/null || fail "the hypervisor packages are not installed"
grep -q '^deb cdrom:' "$R/etc/apt/sources.list" || fail "the test lost its disc source"
chroot "$R" id -u fbrx-core >/dev/null || fail "the fbrx-core account is missing"
echo "OK: FBRX Server's first start sets it up on Debian 13"
