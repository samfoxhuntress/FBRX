#!/usr/bin/env bash
# FBRX Server installer: turns Debian 13 ("trixie") into FBRX Server (FBRX OS for servers), with its web console on
# port 9443 and the roles you pick: the FBRX Virtual hypervisor (KVM through libvirt), the FBRX core (an AI agent on
# FBRX Mesh that lends its AI to the other computers and borrows theirs), and FBRX Gate (routing, firewall, VLANs,
# DHCP and DNS, VPN and traffic priority for your network).
#
#   sudo ./install.sh                 from an unpacked FBRX Server bundle (this script sits next to fbrx-virtual/)
#   sudo ./install.sh --roles virtual hypervisor only, without the AI role
#   sudo ./install.sh --roles gate,ai --gate-wan eno1 --gate-lan eno2
#                                     a gate: the internet on eno1, your network on eno2 (192.168.1.1)
#   sudo ./install.sh --bridge eno1   also put virtual machines straight onto your network through eno1 (after a reboot)
#   sudo ./install.sh --uninstall     take FBRX Server off again (virtual machines and their disks stay)
#
# The FBRX Server ISO runs this at the end of the Debian installer (--no-start).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/fbrx-server
DATA=/var/lib/fbrx-virtual
ETC=/etc/fbrx-virtual
UNIT=/etc/systemd/system/fbrx-virtual.service
CORE_DATA=/var/lib/fbrx-core
CORE_ETC=/etc/fbrx-core
CORE_UNIT=/etc/systemd/system/fbrx-core.service
CORE_USER=fbrx-core
GATE_ETC=/etc/fbrx-gate
GATE_DATA=/var/lib/fbrx-gate
GATE_LOG=/var/log/fbrx-gate
GATE_UNIT=/etc/systemd/system/fbrx-gate-firewall.service
NODE_MAJOR=22
# Roles this installer sets up. Planned roles (command, dns, directory, files) come with later releases.
AVAILABLE_ROLES="virtual ai gate minidome"
PLANNED_ROLES="command dns directory files"

BUNDLE=""
YES=0
START=1
BRIDGE=""
UNINSTALL=0
PURGE=0
FORCE=0
PORT=9443
ROLES="virtual,ai"
GATE_WAN=""
GATE_LAN=""
GATE_MANAGE=""
REBOOT_NEEDED=0
REBOOT_WHY=""

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m !! \033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --bundle <dir|file.tar.gz>  the FBRX Server bundle (default: the folder this script is in)
  --roles <list>              what this server does, comma separated (default virtual,ai):
                                virtual  the FBRX Virtual hypervisor: virtual machines (KVM through libvirt)
                                ai       the FBRX core: an AI agent on FBRX Mesh with Mesh Assist, run from the console
                                gate     FBRX Gate: this server routes and protects your network (needs --gate-wan
                                         and --gate-lan); the console's Gate pages and the fbrx-gate command
                                minidome FBRX MiniDome: watches the network through the gate for threats (with gate)
                              The web console comes with every role.
  --gate-wan <nic>            the gate's internet port (from your modem or provider)
  --gate-lan <nic>            the gate's port to your network (it becomes 192.168.1.1 and hands out addresses)
  --gate-manage <cidr|none>   a private network on the internet side that may still reach the console and SSH
                              (default: the one the internet port is on now, if private, so you are not shut out)
  --bridge <nic>              make bridge br0 on this network port for virtual machines (applies after a reboot)
  --port <n>                  the console's port (default 9443)
  --no-start                  install and enable, but do not start (inside an installer)
  --yes                       do not ask
  --force                     install on something other than Debian 13
  --uninstall [--purge]       remove FBRX Server (--purge also deletes its data: the ISO library, virtual disks and
                              the AI role's settings, mesh pairings and keys)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="${2:?--bundle needs a folder or file}"; shift 2 ;;
    --bridge) BRIDGE="${2:?--bridge needs a network port, like eno1}"; shift 2 ;;
    --roles) ROLES="${2:?--roles needs a list, like virtual,ai}"; shift 2 ;;
    --gate-wan) GATE_WAN="${2:?--gate-wan needs a network port, like eno1}"; shift 2 ;;
    --gate-lan) GATE_LAN="${2:?--gate-lan needs a network port, like eno2}"; shift 2 ;;
    --gate-manage) GATE_MANAGE="${2:?--gate-manage needs a network like 10.0.0.0/24, or none}"; shift 2 ;;
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

# The console (FBRX Virtual's service) comes with every role; the hypervisor only with the virtual role.
ROLE_LIST=""
for r in ${ROLES//,/ }; do
  case " $AVAILABLE_ROLES " in
    *" $r "*) ;;
    *)
      case " $PLANNED_ROLES " in
        *" $r "*) die "The $r role is planned for a later FBRX Server release (available now: ${AVAILABLE_ROLES// /, })" ;;
        *) die "Unknown role $r (available: ${AVAILABLE_ROLES// /, })" ;;
      esac
      ;;
  esac
  case ",$ROLE_LIST," in *",$r,"*) ;; *) ROLE_LIST="${ROLE_LIST:+$ROLE_LIST,}$r" ;; esac
done
[ -n "$ROLE_LIST" ] || die "Pick at least one role (--roles virtual,ai,gate)"
if has_role minidome && ! has_role gate; then die "FBRX MiniDome watches the network through FBRX Gate: use --roles …,gate,minidome"; fi
has_role() { case ",$ROLE_LIST," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
# Text that is there only with a role: "$(with_role ai ', the FBRX core')".
with_role() { if has_role "$1"; then printf '%s' "$2"; fi; }

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
  say "Removing FBRX Server (FBRX Virtual, the AI role and FBRX Gate)"
  systemctl disable --now fbrx-virtual.service 2>/dev/null || true
  systemctl disable --now fbrx-core.service 2>/dev/null || true
  if [ -f "$GATE_UNIT" ]; then
    # The gate's networks go away: the ports get the settings they had before FBRX Gate (after a restart).
    systemctl disable fbrx-gate-firewall.service 2>/dev/null || true
    nft delete table inet fbrx_gate 2>/dev/null || true
    rm -f /etc/logrotate.d/fbrx-gate /etc/systemd/network/10-fbrx-* /etc/systemd/networkd.conf.d/fbrx-gate.conf /etc/dnsmasq.d/fbrx-gate.conf /etc/sysctl.d/90-fbrx-gate.conf /etc/modules-load.d/fbrx-gate.conf
    [ -f /etc/network/interfaces.fbrx-backup ] && mv -f /etc/network/interfaces.fbrx-backup /etc/network/interfaces
    [ -f /etc/resolv.conf.fbrx-backup ] && mv -f /etc/resolv.conf.fbrx-backup /etc/resolv.conf
    systemctl restart dnsmasq.service 2>/dev/null || true
    note "FBRX Gate is off. Restart the server (sudo reboot) for the ports to take their old settings."
  fi
  rm -f "$UNIT" "$CORE_UNIT" "$GATE_UNIT" /usr/local/sbin/fbrx-server /usr/local/sbin/fbrx-gate /etc/fbrx-server-release /etc/issue.d/fbrx-virtual-setup.issue /etc/modules-load.d/fbrx-vfio.conf /etc/motd.d/fbrx-server 2>/dev/null || true
  rm -rf "$APP"
  if [ -f /etc/default/grub.d/fbrx-server.cfg ]; then
    rm -f /etc/default/grub.d/fbrx-server.cfg
    if command -v update-grub >/dev/null; then update-grub >/dev/null 2>&1 || true; fi
  fi
  [ -f /etc/issue.fbrx-backup ] && mv -f /etc/issue.fbrx-backup /etc/issue
  systemctl daemon-reload 2>/dev/null || true
  if [ "$PURGE" -eq 1 ]; then
    if confirm "Delete $DATA (the ISO library, virtual disks, users, settings and the gate's history), $CORE_DATA (the AI role: mesh pairings, keys, chats), $GATE_ETC and $ETC?"; then
      rm -rf "$DATA" "$ETC" "$CORE_DATA" "$CORE_ETC" "$GATE_ETC" "$GATE_DATA" "$GATE_LOG"
      if id "$CORE_USER" >/dev/null 2>&1; then userdel "$CORE_USER" 2>/dev/null || true; fi
      note "Deleted."
    fi
  else
    note "Kept $DATA, $CORE_DATA and $ETC (virtual disks, ISO library, users, mesh pairings). --purge deletes them."
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
if has_role ai && [ ! -f "$BUNDLE/fbrx-core/core.mjs" ]; then die "This bundle has no FBRX core (fbrx-core/core.mjs) for the ai role: use a newer bundle, or --roles virtual"; fi
if has_role gate && [ ! -f "$BUNDLE/fbrx-virtual/gate-cli.mjs" ]; then die "This bundle has no FBRX Gate: use a newer bundle"; fi
VERSION="$(cat "$BUNDLE/VERSION" 2>/dev/null || echo 0.0.0)"

# ------------------------------------------------------------------------------------------- gate ports

env_value() { (grep -E "^$1=" "$ETC/fbrx-virtual.env" 2>/dev/null || true) | tail -1 | cut -d= -f2-; }
GATE_NEW=0
if has_role gate; then
  # A gate already set up keeps its ports unless new ones are given.
  [ -n "$GATE_WAN" ] || GATE_WAN="$(env_value FBRX_V_GATE_WAN)"
  [ -n "$GATE_LAN" ] || GATE_LAN="$(env_value FBRX_V_GATE_LAN)"
  PORTS_NOW=""
  for dev in /sys/class/net/*; do
    case "${dev##*/}" in lo | virbr* | vnet* | br* | docker* | wg* | tap* | tun* | ifb* | '*') ;; *) PORTS_NOW="$PORTS_NOW ${dev##*/}" ;; esac
  done
  if [ -z "$GATE_WAN" ] || [ -z "$GATE_LAN" ]; then die "The gate role needs its two ports: --gate-wan <internet port> --gate-lan <your network's port> (this server has:${PORTS_NOW:- none found})"; fi
  [ "$GATE_WAN" != "$GATE_LAN" ] || die "--gate-wan and --gate-lan must be different ports"
  if [ -n "$BRIDGE" ] && { [ "$GATE_WAN" = "$BRIDGE" ] || [ "$GATE_LAN" = "$BRIDGE" ]; }; then die "The bridge for virtual machines cannot be on one of the gate's ports"; fi
  for nic in "$GATE_WAN" "$GATE_LAN"; do
    [[ "$nic" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$ ]] || die "$nic is not a network port name"
    [ -d "/sys/class/net/$nic" ] || in_chroot || die "There is no network port $nic (this server has:${PORTS_NOW:- none found})"
  done
  [ -f "$GATE_UNIT" ] || GATE_NEW=1
  # So an install made over the internet port does not shut you out: its network (when private) keeps the console and SSH.
  if [ -z "$GATE_MANAGE" ]; then
    GATE_MANAGE="$(env_value FBRX_V_GATE_MANAGE_WAN)"
    if [ -z "$GATE_MANAGE" ] && ! in_chroot; then
      NOW="$(ip -4 -o addr show dev "$GATE_WAN" 2>/dev/null | awk '{print $4; exit}' || true)"
      case "$NOW" in 10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].*) GATE_MANAGE="$NOW" ;; esac
    fi
  fi
  [ "$GATE_MANAGE" = "none" ] && GATE_MANAGE=""
  if [ -n "$GATE_MANAGE" ] && ! [[ "$GATE_MANAGE" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]]; then die "--gate-manage needs a network like 10.0.0.0/24 (or none)"; fi
fi

say "FBRX Server $VERSION · powered by FBRX OS"
note "Roles: ${ROLE_LIST//,/, }"
note "Installs the web console on port $PORT$(with_role virtual ', QEMU/KVM, libvirt and FBRX Virtual')."
if has_role ai; then note "And the FBRX core (ai role): an AI agent on FBRX Mesh (port 47800), run from the console's Mesh & AI page."; fi
if has_role minidome; then note "And FBRX MiniDome: watches the gate's names, connections and devices for threats (MiniDome in the console)."; fi
if has_role gate; then
  note "And FBRX Gate: the internet on $GATE_WAN, your network on $GATE_LAN (192.168.1.1, handing out addresses)."
  if [ -n "$GATE_MANAGE" ]; then note "The console and SSH stay reachable from $GATE_MANAGE on the internet side (--gate-manage none closes that)."; fi
  if [ "$GATE_NEW" -eq 1 ]; then note "The gate takes $GATE_WAN and $GATE_LAN over from the system's network settings (kept as a backup)."; fi
fi
if has_role virtual && ! grep -qE '\b(vmx|svm)\b' /proc/cpuinfo; then
  warn "The processor does not offer virtualization right now: turn on Virtualization Technology in the BIOS."
  note "You can do that later from FBRX Virtual (Server & BIOS) once the iDRAC is connected."
fi
if ! has_role gate && [ -f "$GATE_UNIT" ] && [ "$FORCE" -eq 0 ]; then
  die "This server is a gate: leaving the gate role out takes its networks away. Keep gate in --roles (or --uninstall; --force turns it off anyway)."
fi
confirm "Continue?" || exit 1

# -------------------------------------------------------------------------------------------- packages

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends pciutils ca-certificates curl xz-utils openssl iproute2 >/dev/null
if has_role virtual; then
  say "Installing the hypervisor (QEMU/KVM, libvirt, UEFI firmware, software TPM)"
  apt-get install -y -qq --no-install-recommends \
    qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients ovmf swtpm swtpm-tools \
    dnsmasq-base bridge-utils irqbalance >/dev/null
  systemctl enable libvirtd.service >/dev/null 2>&1 || true
fi
if has_role gate; then
  say "Installing FBRX Gate's tools (nftables, dnsmasq, WireGuard, systemd-networkd)"
  # Until the first commit dnsmasq answers this server only (and leaves port 53 elsewhere, libvirt's included).
  mkdir -p /etc/dnsmasq.d
  if [ ! -f /etc/dnsmasq.d/fbrx-gate.conf ]; then
    printf '%s\n' '# FBRX Gate: replaced at the first commit. Until then dnsmasq answers this server only.' 'interface=lo' 'bind-interfaces' >/etc/dnsmasq.d/fbrx-gate.conf
  fi
  GATE_PKGS="nftables dnsmasq wireguard-tools"
  # MiniDome follows new connections with conntrack's event stream.
  if has_role minidome; then GATE_PKGS="$GATE_PKGS conntrack"; fi
  # Newer Debian ships systemd-networkd on its own.
  if apt-cache show systemd-networkd >/dev/null 2>&1; then GATE_PKGS="$GATE_PKGS systemd-networkd"; fi
  # shellcheck disable=SC2086
  apt-get install -y -qq --no-install-recommends $GATE_PKGS >/dev/null
fi

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
if [ -f "$ETC/fbrx-virtual.env" ]; then
  # Settings added in later releases.
  grep -q '^FBRX_V_CORE_URL=' "$ETC/fbrx-virtual.env" || printf '%s\n' "# The FBRX core on this server (ai role): Mesh & AI in the console" "FBRX_V_CORE_URL=http://127.0.0.1:47821" >>"$ETC/fbrx-virtual.env"
  grep -q '^FBRX_V_CORE_TOKEN_FILE=' "$ETC/fbrx-virtual.env" || printf '%s\n' "FBRX_V_CORE_TOKEN_FILE=$CORE_DATA/console.token" >>"$ETC/fbrx-virtual.env"
  grep -q '^FBRX_V_ROLES=' "$ETC/fbrx-virtual.env" || printf '%s\n' "# What this server does (the console shows these)" "FBRX_V_ROLES=$ROLE_LIST" >>"$ETC/fbrx-virtual.env"
fi
if [ ! -f "$ETC/fbrx-virtual.env" ]; then
  cat >"$ETC/fbrx-virtual.env" <<EOF
# FBRX Virtual settings (sudo systemctl restart fbrx-virtual after a change). See docs/SERVER.md.
FBRX_V_PORT=$PORT
FBRX_V_DATA_DIR=$DATA
FBRX_V_IMAGES_DIR=$DATA/images
FBRX_V_ISOS_DIR=$DATA/isos
FBRX_V_DRIVER=libvirt
FBRX_V_CONSOLE_DIR=$APP/fbrx-virtual/virtual-console
# What this server does (the console shows these)
FBRX_V_ROLES=$ROLE_LIST
# Extra names for the HTTPS certificate (comma separated), e.g. fbrx-server.example.lan
FBRX_V_TLS_NAMES=
# The FBRX core on this server (ai role): Mesh & AI in the console
FBRX_V_CORE_URL=http://127.0.0.1:47821
FBRX_V_CORE_TOKEN_FILE=$CORE_DATA/console.token
EOF
  chmod 0600 "$ETC/fbrx-virtual.env"
else
  sed -i "s/^FBRX_V_PORT=.*/FBRX_V_PORT=$PORT/; s/^FBRX_V_ROLES=.*/FBRX_V_ROLES=$ROLE_LIST/" "$ETC/fbrx-virtual.env"
  note "Kept your settings in $ETC/fbrx-virtual.env"
fi
set_env() {
  if grep -q "^$1=" "$ETC/fbrx-virtual.env"; then sed -i "s|^$1=.*|$1=$2|" "$ETC/fbrx-virtual.env"; else printf '%s=%s\n' "$1" "$2" >>"$ETC/fbrx-virtual.env"; fi
}

# ------------------------------------------------------------------------------------------ ai role

if has_role ai; then
  say "Installing the FBRX core (ai role)"
  rm -rf "$APP/fbrx-core.new"
  cp -r "$BUNDLE/fbrx-core" "$APP/fbrx-core.new"
  rm -rf "$APP/fbrx-core"
  mv "$APP/fbrx-core.new" "$APP/fbrx-core"
  chmod -R go-w "$APP/fbrx-core"
  # Its own account, with no login and no special rights.
  if ! id "$CORE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$CORE_DATA" --no-create-home --shell /usr/sbin/nologin "$CORE_USER"
  fi
  mkdir -p "$CORE_DATA" "$CORE_ETC"
  chown "$CORE_USER:$CORE_USER" "$CORE_DATA"
  chmod 0700 "$CORE_DATA"
  install -m 0644 "$BUNDLE/fbrx-core.service" "$CORE_UNIT"
  cat >"$CORE_ETC/fbrx-core.env" <<EOF
# The FBRX core on FBRX Server (sudo systemctl restart fbrx-core after a change). See docs/SERVER.md.
# Roles this server announces to the other computers on FBRX Mesh (Mesh Assist shows them when picking helpers).
FBRX_SERVER_ROLES=$ROLE_LIST
EOF
  chmod 0644 "$CORE_ETC/fbrx-core.env"
elif [ -f "$CORE_UNIT" ]; then
  say "Turning the ai role off (its data stays in $CORE_DATA)"
  systemctl disable --now fbrx-core.service 2>/dev/null || true
  rm -f "$CORE_UNIT" /etc/systemd/system/multi-user.target.wants/fbrx-core.service
fi

# ---------------------------------------------------------------------------------------- gate role

if has_role gate; then
  say "Setting up FBRX Gate (internet on $GATE_WAN, your network on $GATE_LAN)"
  install -m 0755 "$BUNDLE/fbrx-gate" /usr/local/sbin/fbrx-gate
  install -m 0644 "$BUNDLE/fbrx-gate-firewall.service" "$GATE_UNIT"
  mkdir -p "$GATE_ETC" "$GATE_DATA" "$GATE_LOG"
  chmod 0750 "$GATE_ETC"
  set_env FBRX_V_GATE linux
  set_env FBRX_V_GATE_WAN "$GATE_WAN"
  set_env FBRX_V_GATE_LAN "$GATE_LAN"
  set_env FBRX_V_GATE_MANAGE_WAN "$GATE_MANAGE"
  # The first start puts the starter configuration in place (once: later starts apply what was committed).
  set_env FBRX_V_GATE_FIRST commit
  # The question log (MiniDome reads it) is rotated daily; dnsmasq reopens it on USR2.
  cat >/etc/logrotate.d/fbrx-gate <<EOF
$GATE_LOG/dnsmasq.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl kill -s USR2 dnsmasq.service >/dev/null 2>&1 || true
    endscript
}
EOF
  # Kernel parts the gate uses, loaded at boot: VLANs, the VPN, traffic shaping.
  printf '%s\n' 8021q wireguard sch_cake sch_htb sch_fq_codel ifb act_mirred cls_u32 >/etc/modules-load.d/fbrx-gate.conf
  if ! in_chroot; then for m in 8021q wireguard sch_cake sch_htb ifb act_mirred cls_u32; do modprobe "$m" 2>/dev/null || true; done; fi
  # systemd-networkd runs the gate's ports and VLANs; it leaves routes it did not make alone (libvirt's, others').
  mkdir -p /etc/systemd/networkd.conf.d
  printf '%s\n' '[Network]' 'ManageForeignRoutes=no' 'ManageForeignRoutingPolicyRules=no' >/etc/systemd/networkd.conf.d/fbrx-gate.conf
  # The two ports leave the system's own network settings (ifupdown), which are kept as a backup.
  IFACES=/etc/network/interfaces
  if [ -f "$IFACES" ]; then
    for nic in "$GATE_WAN" "$GATE_LAN"; do
      if grep -qE "^\s*(auto|allow-hotplug|iface)\s+$nic(\s|$)" "$IFACES"; then
        cp -n "$IFACES" "$IFACES.fbrx-backup"
        sed -i -E "s/^(\s*)((auto|allow-hotplug)\s+$nic\s*)$/\1# FBRX Gate runs this port: \2/; s/^(\s*)(iface\s+$nic(\s.*)?)$/\1# FBRX Gate runs this port: \2/" "$IFACES"
        # The stanza's own lines (address, gateway, …) go with it.
        awk -v nic="$nic" '
          /^[[:space:]]*# FBRX Gate runs this port: iface/ && $0 ~ (" " nic "( |$)") { inside = 1; print; next }
          inside && /^[[:space:]]+[a-z]/ && !/^[[:space:]]*(auto|allow-|iface|source|mapping)/ { print "# FBRX Gate runs this port: " $0; next }
          { inside = 0; print }
        ' "$IFACES" >"$IFACES.fbrx-new" && mv -f "$IFACES.fbrx-new" "$IFACES"
        REBOOT_NEEDED=1
        REBOOT_WHY="${REBOOT_WHY:+$REBOOT_WHY, }the gate taking over $nic"
      fi
    done
  fi
  # This server asks its own gate for names (which asks the gate's upstream servers), with one fallback.
  if [ ! -L /etc/resolv.conf ] && ! grep -q '^nameserver 127.0.0.1' /etc/resolv.conf 2>/dev/null; then
    cp -n /etc/resolv.conf /etc/resolv.conf.fbrx-backup 2>/dev/null || true
    printf '%s\n' '# FBRX Gate: this server asks its own DNS (dnsmasq), which asks the upstream servers set in the console.' 'nameserver 127.0.0.1' 'nameserver 1.1.1.1' 'options timeout:2' >/etc/resolv.conf.fbrx-gate
  fi
elif [ -f "$GATE_UNIT" ]; then
  say "Turning the gate role off (--force)"
  systemctl disable fbrx-gate-firewall.service 2>/dev/null || true
  rm -f "$GATE_UNIT" /usr/local/sbin/fbrx-gate
  set_env FBRX_V_GATE_FIRST wait
fi

cat >/etc/fbrx-server-release <<EOF
NAME="FBRX Server"
VERSION="$VERSION"
POWERED_BY="FBRX OS"
$(with_role virtual 'HYPERVISOR="FBRX Virtual"')
ROLES="$ROLE_LIST"
EOF

# ------------------------------------------------------------------------------- devices for machines

# IOMMU (VT-d / AMD-Vi) on, so PCI devices can be given to virtual machines; vfio to hold them.
if has_role virtual; then
  CPU_VENDOR="$(grep -m1 -oE 'GenuineIntel|AuthenticAMD' /proc/cpuinfo || true)"
  IOMMU_ARGS="iommu=pt"
  [ "$CPU_VENDOR" = "GenuineIntel" ] && IOMMU_ARGS="intel_iommu=on iommu=pt"
  [ "$CPU_VENDOR" = "AuthenticAMD" ] && IOMMU_ARGS="amd_iommu=on iommu=pt"
  if [ -d /etc/default/grub.d ] || [ -f /etc/default/grub ]; then
    mkdir -p /etc/default/grub.d
    WANT="GRUB_CMDLINE_LINUX_DEFAULT=\"\$GRUB_CMDLINE_LINUX_DEFAULT $IOMMU_ARGS\""
    if [ "$(cat /etc/default/grub.d/fbrx-server.cfg 2>/dev/null || true)" != "$WANT" ]; then
      printf '%s\n' "$WANT" >/etc/default/grub.d/fbrx-server.cfg
      if command -v update-grub >/dev/null; then update-grub >/dev/null 2>&1 || warn "update-grub failed: add $IOMMU_ARGS to the kernel options yourself"; fi
      REBOOT_NEEDED=1
      REBOOT_WHY="${REBOOT_WHY:+$REBOOT_WHY, }device passthrough"
    fi
  fi
  printf 'vfio\nvfio_iommu_type1\nvfio_pci\n' >/etc/modules-load.d/fbrx-vfio.conf
fi

# ------------------------------------------------------------------------------------- bridge (optional)

if [ -n "$BRIDGE" ] && ! has_role virtual; then warn "--bridge is for virtual machines (the virtual role): left out"; BRIDGE=""; fi
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
    REBOOT_WHY="${REBOOT_WHY:+$REBOOT_WHY, }the bridge"
    note "Saved (the old file is $IFACES.fbrx-backup). It takes over after the reboot; the server's address may change."
  else
    warn "$BRIDGE is not set up with DHCP in $IFACES: add the bridge by hand (docs/SERVER.md shows how)."
  fi
fi

# ------------------------------------------------------------------------------------ screen and motd

[ -f /etc/issue ] && [ ! -f /etc/issue.fbrx-backup ] && cp /etc/issue /etc/issue.fbrx-backup
if has_role gate; then
  cat >/etc/issue <<EOF
FBRX Server $VERSION · powered by FBRX OS  (\n, \l)

FBRX Gate: the internet on $GATE_WAN, your network on $GATE_LAN.
Open the console from a computer on your network:  https://192.168.1.1:$PORT
(or https://\4:$PORT${GATE_MANAGE:+ from $GATE_MANAGE})

EOF
else
  cat >/etc/issue <<EOF
FBRX Server $VERSION · powered by FBRX OS  (\n, \l)

Open the FBRX Virtual console from another computer:  https://\4:$PORT

EOF
fi
mkdir -p /etc/issue.d
ln -sf "$DATA/setup-code.issue" /etc/issue.d/fbrx-virtual-setup.issue
mkdir -p /etc/motd.d 2>/dev/null || true
cat >/etc/motd.d/fbrx-server 2>/dev/null <<EOF || true

  FBRX Server · powered by FBRX OS
  fbrx-server status   where the console is, and how things are
  fbrx-server help     everything else
$(with_role gate '  fbrx-gate status     the gate: ports, devices, problems (fbrx-gate help: the rest)')
EOF

# ---------------------------------------------------------------------------------------------- start

systemctl daemon-reload 2>/dev/null || true
mkdir -p /etc/systemd/system/multi-user.target.wants
systemctl enable fbrx-virtual.service >/dev/null 2>&1 || ln -sf "$UNIT" /etc/systemd/system/multi-user.target.wants/fbrx-virtual.service
if has_role ai; then systemctl enable fbrx-core.service >/dev/null 2>&1 || ln -sf "$CORE_UNIT" /etc/systemd/system/multi-user.target.wants/fbrx-core.service; fi
if has_role gate; then
  mkdir -p /etc/systemd/system/sysinit.target.wants
  systemctl enable fbrx-gate-firewall.service >/dev/null 2>&1 || ln -sf "$GATE_UNIT" /etc/systemd/system/sysinit.target.wants/fbrx-gate-firewall.service
  systemctl enable systemd-networkd.service >/dev/null 2>&1 || true
  systemctl enable dnsmasq.service >/dev/null 2>&1 || true
  # Names through the gate's own DNS from now on.
  if [ -f /etc/resolv.conf.fbrx-gate ]; then mv -f /etc/resolv.conf.fbrx-gate /etc/resolv.conf; fi
  # Taking the ports over while connected through one of them could cut you off: that waits for the restart.
  if [ "$GATE_NEW" -eq 1 ] && [ "$REBOOT_NEEDED" -eq 1 ] && [ "$START" -eq 1 ] && ! in_chroot; then
    START=0
    note "FBRX Gate starts with the restart (it takes $GATE_WAN and $GATE_LAN over then)."
  fi
fi

if [ "$START" -eq 1 ] && ! in_chroot; then
  if has_role virtual; then systemctl restart libvirtd.service || warn "libvirt did not start (journalctl -u libvirtd)"; fi
  if has_role gate; then
    systemctl restart systemd-networkd.service || warn "systemd-networkd did not start (journalctl -u systemd-networkd)"
    systemctl restart dnsmasq.service || warn "dnsmasq did not start (journalctl -u dnsmasq)"
  fi
  if has_role ai; then systemctl restart fbrx-core.service || warn "The FBRX core did not start (journalctl -u fbrx-core)"; fi
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
  note "Enabled: the console$(with_role ai ', the FBRX core')$(with_role gate ' and FBRX Gate') start with the server."
fi

echo
say "FBRX Server is installed."
if has_role gate; then
  note "Plug a computer into $GATE_LAN: it gets an address. Open https://192.168.1.1:$PORT and sign in with the setup code (fbrx-server setup-code)."
else
  note "Open https://<this server>:$PORT and sign in with the setup code (fbrx-server setup-code)."
fi
note "Your browser warns about the certificate the first time: compare it with fbrx-server fingerprint."
if has_role ai; then note "Then open Mesh & AI in the console: pick this server's AI provider and pair it with your other computers."; fi
if has_role gate; then note "The Gate pages (or fbrx-gate on this server) change networks, VLANs, the firewall, the VPN and Prefer Mesh: edit, review, commit."; fi
if [ "$REBOOT_NEEDED" -eq 1 ]; then note "Restart the server once (sudo reboot) for ${REBOOT_WHY:-the changes}."; fi
