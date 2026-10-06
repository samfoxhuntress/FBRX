#!/usr/bin/env bash
# FBRX Server installer: turns Debian 13 ("trixie") into FBRX Server (FBRX OS for servers), running the FBRX Virtual
# hypervisor (KVM through libvirt) with its web console on port 9443.
#
#   sudo ./install.sh                 from an unpacked FBRX Server bundle (this script sits next to fbrx-virtual/)
#   sudo ./install.sh --bridge eno1   also put virtual machines straight onto your network through eno1 (after a reboot)
#   sudo ./install.sh --uninstall     take FBRX Virtual off again (virtual machines and their disks stay)
#
# The FBRX Server ISO runs this at the end of the Debian installer (--no-start).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/fbrx-server
DATA=/var/lib/fbrx-virtual
ETC=/etc/fbrx-virtual
UNIT=/etc/systemd/system/fbrx-virtual.service
NODE_MAJOR=22

BUNDLE=""
YES=0
START=1
BRIDGE=""
UNINSTALL=0
PURGE=0
FORCE=0
PORT=9443

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m !! \033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --bundle <dir|file.tar.gz>  the FBRX Server bundle (default: the folder this script is in)
  --bridge <nic>              make bridge br0 on this network port for virtual machines (applies after a reboot)
  --port <n>                  the console's port (default 9443)
  --no-start                  install and enable, but do not start (inside an installer)
  --yes                       do not ask
  --force                     install on something other than Debian 13
  --uninstall [--purge]       remove FBRX Virtual (--purge also deletes its data: the ISO library and virtual disks)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="${2:?--bundle needs a folder or file}"; shift 2 ;;
    --bridge) BRIDGE="${2:?--bridge needs a network port, like eno1}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --no-start) START=0; shift ;;
    --yes | -y) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown option $1 (--help lists them)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run this as root: sudo $0 $*"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "--port must be a number"

confirm() {
  [ "$YES" -eq 1 ] && return 0
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]]
}

in_chroot() {
  # The Debian installer runs this inside the new system before its first boot.
  [ "$(stat -c %d:%i /)" != "$(stat -c %d:%i /proc/1/root/. 2>/dev/null || echo x)" ]
}

# ------------------------------------------------------------------------------------------- uninstall

if [ "$UNINSTALL" -eq 1 ]; then
  say "Removing FBRX Virtual"
  systemctl disable --now fbrx-virtual.service 2>/dev/null || true
  rm -f "$UNIT" /usr/local/sbin/fbrx-server /etc/fbrx-server-release /etc/issue.d/fbrx-virtual-setup.issue /etc/modules-load.d/fbrx-vfio.conf /etc/motd.d/fbrx-server 2>/dev/null || true
  rm -rf "$APP"
  if [ -f /etc/default/grub.d/fbrx-server.cfg ]; then
    rm -f /etc/default/grub.d/fbrx-server.cfg
    if command -v update-grub >/dev/null; then update-grub >/dev/null 2>&1 || true; fi
  fi
  [ -f /etc/issue.fbrx-backup ] && mv -f /etc/issue.fbrx-backup /etc/issue
  systemctl daemon-reload 2>/dev/null || true
  if [ "$PURGE" -eq 1 ]; then
    confirm "Delete $DATA (the ISO library, virtual disks, users and settings) and $ETC?" && rm -rf "$DATA" "$ETC" && note "Deleted."
  else
    note "Kept $DATA and $ETC (virtual disks, ISO library, users). --purge deletes them."
  fi
  note "Virtual machines stay defined in libvirt (virsh list --all). libvirt and QEMU stay installed."
  exit 0
fi

# ---------------------------------------------------------------------------------------------- checks

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) die "FBRX Server runs on 64-bit x86 or ARM servers (this is $ARCH)" ;;
esac

# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "debian" ] || [ "${VERSION_ID:-}" != "13" ]; then
  [ "$FORCE" -eq 1 ] || die "FBRX Server is built on Debian 13 (this is ${PRETTY_NAME:-unknown}). --force tries anyway."
  warn "Not Debian 13 (${PRETTY_NAME:-unknown}): continuing because of --force"
fi

if [ -z "$BUNDLE" ]; then BUNDLE="$HERE"; fi
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT
if [ -f "$BUNDLE" ]; then
  WORK="$(mktemp -d)"
  tar -xzf "$BUNDLE" -C "$WORK"
  BUNDLE="$(dirname "$(find "$WORK" -maxdepth 3 -path '*/fbrx-virtual/server.mjs' | head -1)")/.."
fi
BUNDLE="$(cd "$BUNDLE" && pwd)"
[ -f "$BUNDLE/fbrx-virtual/server.mjs" ] || die "No FBRX Virtual in $BUNDLE (expected fbrx-virtual/server.mjs). Use the FBRX Server bundle."
VERSION="$(cat "$BUNDLE/VERSION" 2>/dev/null || echo 0.0.0)"

say "FBRX Server $VERSION · powered by FBRX OS"
note "Installs QEMU/KVM, libvirt and FBRX Virtual (web console on port $PORT)."
if ! grep -qE '\b(vmx|svm)\b' /proc/cpuinfo; then
  warn "The processor does not offer virtualization right now: turn on Virtualization Technology in the BIOS."
  note "You can do that later from FBRX Virtual (Server & BIOS) once the iDRAC is connected."
fi
confirm "Continue?" || exit 1

# -------------------------------------------------------------------------------------------- packages

say "Installing the hypervisor (QEMU/KVM, libvirt, UEFI firmware, software TPM)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients ovmf swtpm swtpm-tools \
  dnsmasq-base bridge-utils pciutils irqbalance ca-certificates curl xz-utils openssl iproute2 >/dev/null
systemctl enable libvirtd.service >/dev/null 2>&1 || true

# ------------------------------------------------------------------------------------------------ Node

node_ok() { [ -x "$APP/node/bin/node" ] && [ "$("$APP/node/bin/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; }
if node_ok; then
  note "Node.js $("$APP/node/bin/node" -v) already in place"
else
  say "Installing Node.js $NODE_MAJOR (FBRX Virtual's runtime, kept in $APP/node)"
  mkdir -p "$APP"
  TARBALL="$(find "$BUNDLE" -maxdepth 1 -name "node-v${NODE_MAJOR}.*-linux-${NODE_ARCH}.tar.xz" | sort | tail -1)"
  NODE_TMP="$(mktemp -d)"
  if [ -n "$TARBALL" ]; then
    note "From the bundle: $(basename "$TARBALL")"
    cp "$TARBALL" "$NODE_TMP/"
    if [ -f "$TARBALL.sha256" ]; then (cd "$NODE_TMP" && cp "$TARBALL.sha256" . && sha256sum -c --quiet "$(basename "$TARBALL").sha256") || die "The bundled Node.js does not match its checksum"; fi
  else
    BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
    curl -fsSL "$BASE/SHASUMS256.txt" -o "$NODE_TMP/SHASUMS256.txt"
    NAME="$(grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${NODE_ARCH}\.tar\.xz" "$NODE_TMP/SHASUMS256.txt" | head -1)"
    [ -n "$NAME" ] || die "Could not find Node.js $NODE_MAJOR for $NODE_ARCH on nodejs.org"
    note "Downloading $NAME"
    curl -fsSL "$BASE/$NAME" -o "$NODE_TMP/$NAME"
    (cd "$NODE_TMP" && grep " $NAME\$" SHASUMS256.txt | sha256sum -c --quiet) || die "Node.js download does not match nodejs.org's checksum"
    TARBALL="$NODE_TMP/$NAME"
  fi
  rm -rf "$APP/node.new"
  mkdir -p "$APP/node.new"
  tar -xJf "$NODE_TMP/$(basename "$TARBALL")" -C "$APP/node.new" --strip-components=1
  rm -rf "$APP/node" "$NODE_TMP"
  mv "$APP/node.new" "$APP/node"
fi

# ---------------------------------------------------------------------------------------- FBRX Virtual

say "Installing FBRX Virtual $VERSION"
rm -rf "$APP/fbrx-virtual.new"
cp -r "$BUNDLE/fbrx-virtual" "$APP/fbrx-virtual.new"
rm -rf "$APP/fbrx-virtual"
mv "$APP/fbrx-virtual.new" "$APP/fbrx-virtual"
install -m 0755 "$BUNDLE/fbrx-server" /usr/local/sbin/fbrx-server
install -m 0644 "$BUNDLE/fbrx-virtual.service" "$UNIT"

mkdir -p "$ETC" "$DATA/images" "$DATA/isos"
chmod 0755 "$DATA" "$DATA/images" "$DATA/isos"
if [ ! -f "$ETC/fbrx-virtual.env" ]; then
  cat >"$ETC/fbrx-virtual.env" <<EOF
# FBRX Virtual settings (sudo systemctl restart fbrx-virtual after a change). See docs/SERVER.md.
FBRX_V_PORT=$PORT
FBRX_V_DATA_DIR=$DATA
FBRX_V_IMAGES_DIR=$DATA/images
FBRX_V_ISOS_DIR=$DATA/isos
FBRX_V_DRIVER=libvirt
FBRX_V_CONSOLE_DIR=$APP/fbrx-virtual/virtual-console
# Extra names for the HTTPS certificate (comma separated), e.g. fbrx-server.example.lan
FBRX_V_TLS_NAMES=
EOF
  chmod 0600 "$ETC/fbrx-virtual.env"
else
  sed -i "s/^FBRX_V_PORT=.*/FBRX_V_PORT=$PORT/" "$ETC/fbrx-virtual.env"
  note "Kept your settings in $ETC/fbrx-virtual.env"
fi

cat >/etc/fbrx-server-release <<EOF
NAME="FBRX Server"
VERSION="$VERSION"
POWERED_BY="FBRX OS"
HYPERVISOR="FBRX Virtual"
EOF

# ------------------------------------------------------------------------------- devices for machines

# IOMMU (VT-d / AMD-Vi) on, so PCI devices can be given to virtual machines; vfio to hold them.
CPU_VENDOR="$(grep -m1 -oE 'GenuineIntel|AuthenticAMD' /proc/cpuinfo || true)"
IOMMU_ARGS="iommu=pt"
[ "$CPU_VENDOR" = "GenuineIntel" ] && IOMMU_ARGS="intel_iommu=on iommu=pt"
[ "$CPU_VENDOR" = "AuthenticAMD" ] && IOMMU_ARGS="amd_iommu=on iommu=pt"
REBOOT_NEEDED=0
if [ -d /etc/default/grub.d ] || [ -f /etc/default/grub ]; then
  mkdir -p /etc/default/grub.d
  WANT="GRUB_CMDLINE_LINUX_DEFAULT=\"\$GRUB_CMDLINE_LINUX_DEFAULT $IOMMU_ARGS\""
  if [ "$(cat /etc/default/grub.d/fbrx-server.cfg 2>/dev/null || true)" != "$WANT" ]; then
    printf '%s\n' "$WANT" >/etc/default/grub.d/fbrx-server.cfg
    if command -v update-grub >/dev/null; then update-grub >/dev/null 2>&1 || warn "update-grub failed: add $IOMMU_ARGS to the kernel options yourself"; fi
    REBOOT_NEEDED=1
  fi
fi
printf 'vfio\nvfio_iommu_type1\nvfio_pci\n' >/etc/modules-load.d/fbrx-vfio.conf

# ------------------------------------------------------------------------------------- bridge (optional)

if [ -n "$BRIDGE" ]; then
  say "Bridge br0 on $BRIDGE (virtual machines get addresses from your network)"
  IFACES=/etc/network/interfaces
  [ -d "/sys/class/net/$BRIDGE" ] || in_chroot || die "There is no network port $BRIDGE (ip link lists them)"
  if grep -qE "^\s*iface\s+br0\b" "$IFACES" 2>/dev/null; then
    note "br0 is already set up in $IFACES"
  elif grep -qE "^\s*iface\s+$BRIDGE\s+inet\s+dhcp" "$IFACES" 2>/dev/null; then
    cp -n "$IFACES" "$IFACES.fbrx-backup"
    sed -i -E "s/^(\s*)(allow-hotplug|auto)\s+$BRIDGE\s*$/\1auto $BRIDGE/; s/^(\s*)iface\s+$BRIDGE\s+inet\s+dhcp/\1iface $BRIDGE inet manual/" "$IFACES"
    cat >>"$IFACES" <<EOF

# FBRX Server: virtual machines reach your network through this bridge.
auto br0
iface br0 inet dhcp
    bridge_ports $BRIDGE
    bridge_stp off
    bridge_fd 0
EOF
    REBOOT_NEEDED=1
    note "Saved (the old file is $IFACES.fbrx-backup). It takes over after the reboot; the server's address may change."
  else
    warn "$BRIDGE is not set up with DHCP in $IFACES: add the bridge by hand (docs/SERVER.md shows how)."
  fi
fi

# ------------------------------------------------------------------------------------ screen and motd

[ -f /etc/issue ] && [ ! -f /etc/issue.fbrx-backup ] && cp /etc/issue /etc/issue.fbrx-backup
cat >/etc/issue <<EOF
FBRX Server $VERSION · powered by FBRX OS  (\n, \l)

Open the FBRX Virtual console from another computer:  https://\4:$PORT

EOF
mkdir -p /etc/issue.d
ln -sf "$DATA/setup-code.issue" /etc/issue.d/fbrx-virtual-setup.issue
mkdir -p /etc/motd.d 2>/dev/null || true
cat >/etc/motd.d/fbrx-server 2>/dev/null <<'EOF' || true

  FBRX Server · powered by FBRX OS
  fbrx-server status   where the console is, and how things are
  fbrx-server help     everything else

EOF

# ---------------------------------------------------------------------------------------------- start

systemctl daemon-reload 2>/dev/null || true
systemctl enable fbrx-virtual.service >/dev/null 2>&1 || ln -sf "$UNIT" /etc/systemd/system/multi-user.target.wants/fbrx-virtual.service

if [ "$START" -eq 1 ] && ! in_chroot; then
  systemctl restart libvirtd.service || warn "libvirt did not start (journalctl -u libvirtd)"
  systemctl restart fbrx-virtual.service
  say "Starting FBRX Virtual"
  for _ in $(seq 1 30); do
    [ -f "$DATA/tls/virtual.crt" ] && curl -fsk "https://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -fsk "https://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo
    /usr/local/sbin/fbrx-server status
  else
    warn "FBRX Virtual did not answer yet: fbrx-server logs shows why."
  fi
else
  note "Enabled: FBRX Virtual starts with the server."
fi

echo
say "FBRX Server is installed."
note "Open https://<this server>:$PORT and sign in with the setup code (fbrx-server setup-code)."
note "Your browser warns about the certificate the first time: compare it with fbrx-server fingerprint."
if [ "$REBOOT_NEEDED" -eq 1 ]; then note "Restart the server once (sudo reboot) to turn on device passthrough${BRIDGE:+ and the bridge}."; fi
