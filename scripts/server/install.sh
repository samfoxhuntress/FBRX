#!/usr/bin/env bash
# FBRX Server installer: turns Debian 13 ("trixie") into FBRX Server (FBRX OS for servers), with its web console on
# port 9443 and the roles you pick: the FBRX Virtual hypervisor (KVM through libvirt), the FBRX core (an AI agent on
# FBRX Mesh that lends its AI to the other computers and borrows theirs), FBRX Gate (routing, firewall, VLANs, DHCP
# and DNS, VPN and traffic priority for your network), FBRX Time (image backups) and FBRX Command (your organization's
# computers, settings, policy and updates).
#
#   sudo ./install.sh                 from an unpacked FBRX Server bundle (this script sits next to fbrx-virtual/)
#   sudo ./install.sh --roles virtual hypervisor only, without the AI role
#   sudo ./install.sh --roles gate,ai --gate-wan eno1 --gate-lan eno2
#                                     a gate: the internet on eno1, your network on eno2 (192.168.1.1, or another
#                                     network when the router in front already uses 192.168.1.x)
#   sudo ./install.sh --roles virtual,ai,command
#                                     also run your organization's FBRX Command (its own console on port 8787)
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
CMD_DATA=/var/lib/fbrx-command
CMD_ETC=/etc/fbrx-command
CMD_UNIT=/etc/systemd/system/fbrx-command.service
CMD_USER=fbrx-command
NODE_MAJOR=22
# Roles this installer sets up. Planned roles (dns, directory, files) come with later releases.
AVAILABLE_ROLES="virtual ai gate minidome time command"
PLANNED_ROLES="dns directory files"

BUNDLE=""
YES=0
START=1
BRIDGE=""
UNINSTALL=0
PURGE=0
FORCE=0
PORT=""
ROLES=""
GATE_WAN=""
GATE_LAN=""
GATE_MANAGE=""
GATE_LAN_ADDRESS=""
GATE_WAN_ADDRESS=""
GATE_WAN_GATEWAY=""
CMD_ADDRESS=""
REBOOT=0
NO_START=0
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
  --roles <list>              what this server does, comma separated (default: the ones it has, or virtual,ai):
                                virtual  the FBRX Virtual hypervisor: virtual machines (KVM through libvirt)
                                ai       the FBRX core: an AI agent on FBRX Mesh with Mesh Assist, run from the console
                                gate     FBRX Gate: this server routes and protects your network (needs --gate-wan
                                         and --gate-lan); the console's Gate pages and the fbrx-gate command
                                minidome FBRX MiniDome: watches the network through the gate for threats (with gate)
                                time     FBRX Time: image backups of virtual machines and computers, each checked by
                                         starting it as a throwaway machine (with virtual); a backup folder (SMB)
                                         for computers
                                command  FBRX Command: your organization's computers, their settings and policy,
                                         licenses and updates, with its own console on port 8787
                              The web console comes with every role. The server keeps a copy of this installer, so
                              roles change later from the console (Roles) or with sudo fbrx-server roles add <role>.
  --gate-wan <nic>            the gate's internet port (from your modem or provider)
  --gate-lan <nic>            the gate's port to your network (it becomes 192.168.1.1 and hands out addresses)
  --gate-lan-address <cidr>   your network's addresses instead, like 192.168.50.1/24 (default: 192.168.1.1/24, or
                              the next free choice when the internet side already uses it)
  --gate-wan-address <cidr>   a fixed internet address, like 203.0.113.2/29 (default: the one the port is set to now
  --gate-wan-gateway <ip>     in /etc/network/interfaces when that is fixed, else DHCP from the modem or router)
  --gate-manage <cidr|none>   a private network on the internet side that may still reach the console and SSH
                              (default: the one the internet port is on now, if private, so you are not shut out)
  --command-address <name>    the address computers use for FBRX Command (command role): a name in your DNS or an
                              address (default: the one it has, or this server's address; on a gate, the gate's)
  --bridge <nic>              make bridge br0 on this network port for virtual machines (applies after a reboot)
  --port <n>                  the console's port (default: the one it has, or 9443)
  --no-start                  install and enable, but do not start (inside an installer)
  --reboot                    restart the server at the end when a change waits for it (the gate taking its ports)
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
    --gate-lan-address) GATE_LAN_ADDRESS="${2:?--gate-lan-address needs an address like 192.168.50.1/24}"; shift 2 ;;
    --gate-wan-address) GATE_WAN_ADDRESS="${2:?--gate-wan-address needs an address like 203.0.113.2/29}"; shift 2 ;;
    --gate-wan-gateway) GATE_WAN_GATEWAY="${2:?--gate-wan-gateway needs the gateway address, like 203.0.113.1}"; shift 2 ;;
    --command-address) CMD_ADDRESS="${2:?--command-address needs a name or address, like command.example.lan}"; shift 2 ;;
    --reboot) REBOOT=1; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --no-start) START=0; NO_START=1; shift ;;
    --yes | -y) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown option $1 (--help lists them)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run this as root: sudo $0 $*"
# Run again (an update, another role), the server keeps its port and roles unless new ones are given.
existing() { (grep -E "^$1=" "$ETC/fbrx-virtual.env" 2>/dev/null || true) | tail -1 | cut -d= -f2-; }
[ -n "$PORT" ] || PORT="$(existing FBRX_V_PORT)"
PORT="${PORT:-9443}"
[ -n "$ROLES" ] || ROLES="$(existing FBRX_V_ROLES)"
ROLES="${ROLES:-virtual,ai}"
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
has_role() { case ",$ROLE_LIST," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
# Text that is there only with a role: "$(with_role ai ', the FBRX core')".
with_role() { if has_role "$1"; then printf '%s' "$2"; fi; }
if has_role minidome && ! has_role gate; then die "FBRX MiniDome watches the network through FBRX Gate: use --roles …,gate,minidome"; fi
if has_role time && ! has_role virtual; then die "FBRX Time copies and checks images with the hypervisor: use --roles virtual,…,time"; fi

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
  say "Removing FBRX Server (FBRX Virtual and its roles)"
  systemctl disable --now fbrx-virtual.service 2>/dev/null || true
  systemctl disable --now fbrx-core.service 2>/dev/null || true
  systemctl disable --now fbrx-command.service 2>/dev/null || true
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
  systemctl disable fbrx-server-firstboot.service 2>/dev/null || true
  rm -f /etc/systemd/system/fbrx-server-firstboot.service /etc/issue.d/fbrx-server-firstboot.issue
  rm -f "$UNIT" "$CORE_UNIT" "$CMD_UNIT" "$GATE_UNIT" /usr/local/sbin/fbrx-server /usr/local/sbin/fbrx-gate /etc/fbrx-server-release /etc/issue.d/fbrx-virtual-setup.issue /etc/modules-load.d/fbrx-vfio.conf /etc/motd.d/fbrx-server 2>/dev/null || true
  rm -rf "$APP"
  if [ -f /etc/default/grub.d/fbrx-server.cfg ]; then
    rm -f /etc/default/grub.d/fbrx-server.cfg
    if command -v update-grub >/dev/null; then update-grub >/dev/null 2>&1 || true; fi
  fi
  [ -f /etc/issue.fbrx-backup ] && mv -f /etc/issue.fbrx-backup /etc/issue
  systemctl daemon-reload 2>/dev/null || true
  if [ "$PURGE" -eq 1 ]; then
    if confirm "Delete $DATA (the ISO library, virtual disks, users, settings and the gate's history), $CORE_DATA (the AI role: mesh pairings, keys, chats), $CMD_DATA (FBRX Command: its computers, settings, keys and uploads), $GATE_ETC and $ETC?"; then
      rm -rf "$DATA" "$ETC" "$CORE_DATA" "$CORE_ETC" "$CMD_DATA" "$CMD_ETC" "$GATE_ETC" "$GATE_DATA" "$GATE_LOG"
      if id "$CORE_USER" >/dev/null 2>&1; then userdel "$CORE_USER" 2>/dev/null || true; fi
      if id "$CMD_USER" >/dev/null 2>&1; then userdel "$CMD_USER" 2>/dev/null || true; fi
      note "Deleted."
    fi
  else
    note "Kept $DATA, $CORE_DATA, $CMD_DATA and $ETC (virtual disks, ISO library, users, mesh pairings, FBRX Command's data). --purge deletes them."
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
APT_SOURCES=""
# An EXIT trap's last status becomes the script's: it must end in success, or a finished install reports failure.
cleanup() {
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  if [ -n "$APT_SOURCES" ]; then rm -f "$APT_SOURCES"; fi
  return 0
}
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
if has_role command && [ ! -f "$BUNDLE/fbrx-command/server.mjs" ]; then die "This bundle has no FBRX Command (fbrx-command/server.mjs) for the command role: use a newer bundle"; fi
VERSION="$(cat "$BUNDLE/VERSION" 2>/dev/null || echo 0.0.0)"

# ------------------------------------------------------------------------------------------- gate ports

env_value() { existing "$1"; }
is_ip() { [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] && [ "${BASH_REMATCH[1]}" -le 255 ] && [ "${BASH_REMATCH[2]}" -le 255 ] && [ "${BASH_REMATCH[3]}" -le 255 ] && [ "${BASH_REMATCH[4]}" -le 255 ]; }
is_cidr() { is_ip "${1%/*}" && [[ "$1" =~ /([0-9]{1,2})$ ]] && [ "${BASH_REMATCH[1]}" -le 32 ]; }
ip_int() { local IFS=.; read -r a b c d <<<"$1"; echo $(((a << 24) | (b << 16) | (c << 8) | d)); }
# Two networks (address/size) share addresses.
overlaps() {
  local p=$((${1#*/} < ${2#*/} ? ${1#*/} : ${2#*/}))
  local mask=$(((0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF))
  [ $(($(ip_int "${1%/*}") & mask)) -eq $(($(ip_int "${2%/*}") & mask)) ]
}
mask_bits() { local n bits=0; n=$(ip_int "$1"); while [ $((n & 0x80000000)) -ne 0 ]; do bits=$((bits + 1)); n=$(((n << 1) & 0xFFFFFFFF)); done; echo "$bits"; }
# "address/size gateway" of a port set to a fixed address in /etc/network/interfaces (nothing when it uses DHCP).
static_of() {
  [ -f /etc/network/interfaces ] || return 0
  local address netmask gateway
  read -r address netmask gateway <<<"$(awk -v nic="$1" '
    $1 == "iface" { inside = ($2 == nic && $3 == "inet" && $4 == "static"); next }
    $1 ~ /^(auto|allow-|source|mapping)/ { inside = 0 }
    inside && $1 == "address" { a = $2 } inside && $1 == "netmask" { m = $2 } inside && $1 == "gateway" { g = $2 }
    END { print (a ? a : "-"), (m ? m : "-"), (g ? g : "-") }' /etc/network/interfaces)"
  [ "$address" != "-" ] && [ "$gateway" != "-" ] || return 0
  if [[ "$address" != */* ]]; then
    if [ "$netmask" != "-" ] && is_ip "$netmask"; then address="$address/$(mask_bits "$netmask")"; else address="$address/24"; fi
  fi
  echo "$address $gateway"
}
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
  if [ -n "$GATE_MANAGE" ] && ! is_cidr "$GATE_MANAGE"; then die "--gate-manage needs a network like 10.0.0.0/24 (or none)"; fi

  # A fixed internet address set in the system's settings goes with the port, so the server keeps it under the gate.
  [ -n "$GATE_WAN_ADDRESS" ] || GATE_WAN_ADDRESS="$(env_value FBRX_V_GATE_WAN_ADDRESS)"
  [ -n "$GATE_WAN_GATEWAY" ] || GATE_WAN_GATEWAY="$(env_value FBRX_V_GATE_WAN_GATEWAY)"
  if [ -z "$GATE_WAN_ADDRESS" ] && [ "$GATE_NEW" -eq 1 ]; then
    read -r STATIC_ADDRESS STATIC_GATEWAY <<<"$(static_of "$GATE_WAN")"
    if [ -n "$STATIC_ADDRESS" ] && [ -n "$STATIC_GATEWAY" ]; then
      GATE_WAN_ADDRESS="$STATIC_ADDRESS"
      GATE_WAN_GATEWAY="$STATIC_GATEWAY"
    fi
  fi
  if [ -n "$GATE_WAN_ADDRESS" ] || [ -n "$GATE_WAN_GATEWAY" ]; then
    is_cidr "$GATE_WAN_ADDRESS" || die "--gate-wan-address needs the address with its size, like 203.0.113.2/29"
    is_ip "$GATE_WAN_GATEWAY" || die "A fixed internet address needs its gateway too: --gate-wan-gateway <the router's address>"
    overlaps "$GATE_WAN_GATEWAY/32" "$GATE_WAN_ADDRESS" || die "The gateway $GATE_WAN_GATEWAY is not in $GATE_WAN_ADDRESS's network"
  fi

  # Your network's addresses: clear of the internet side's (a router in front handing out 192.168.1.x, say).
  [ -n "$GATE_LAN_ADDRESS" ] || GATE_LAN_ADDRESS="$(env_value FBRX_V_GATE_LAN_ADDRESS)"
  WAN_NOW="${GATE_WAN_ADDRESS:-$(ip -4 -o addr show dev "$GATE_WAN" scope global 2>/dev/null | awk '{print $4; exit}' || true)}"
  if [ -z "$GATE_LAN_ADDRESS" ]; then
    for c in 192.168.1.1/24 192.168.10.1/24 192.168.50.1/24 192.168.88.1/24 10.10.0.1/24 172.20.0.1/24; do
      if { [ -z "$WAN_NOW" ] || ! overlaps "$c" "$WAN_NOW"; } && { [ -z "$GATE_MANAGE" ] || ! overlaps "$c" "$GATE_MANAGE"; }; then GATE_LAN_ADDRESS="$c"; break; fi
    done
  fi
  is_cidr "$GATE_LAN_ADDRESS" || die "--gate-lan-address needs an address with its size, like 192.168.50.1/24"
  if [ -n "$WAN_NOW" ] && overlaps "$GATE_LAN_ADDRESS" "$WAN_NOW"; then die "Your network ($GATE_LAN_ADDRESS) overlaps the internet side ($WAN_NOW): pick another with --gate-lan-address"; fi
  GATE_LAN_IP="${GATE_LAN_ADDRESS%/*}"
fi

say "FBRX Server $VERSION · powered by FBRX OS"
note "Roles: ${ROLE_LIST//,/, }"
note "Installs the web console on port $PORT$(with_role virtual ', QEMU/KVM, libvirt and FBRX Virtual')."
if has_role ai; then note "And the FBRX core (ai role): an AI agent on FBRX Mesh (port 47800), run from the console's Mesh & AI page."; fi
if has_role minidome; then note "And FBRX MiniDome: watches the gate's names, connections and devices for threats (MiniDome in the console)."; fi
if has_role command; then note "And FBRX Command: your organization's computers, their settings and policy, licenses and updates, with its own console."; fi
if has_role gate; then
  note "And FBRX Gate: the internet on $GATE_WAN${GATE_WAN_ADDRESS:+ (fixed address $GATE_WAN_ADDRESS via $GATE_WAN_GATEWAY)}, your network on $GATE_LAN ($GATE_LAN_IP, handing out addresses)."
  if [ "$GATE_LAN_ADDRESS" != "192.168.1.1/24" ] && [ -n "$WAN_NOW" ] && overlaps 192.168.1.1/24 "$WAN_NOW"; then note "Not 192.168.1.1: the internet side already uses those addresses ($WAN_NOW)."; fi
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
# Packages come from the network. A "cdrom:" source (the Debian installer leaves one while it runs, and a DVD install
# keeps it) would make apt stop and wait for the disc, so it is left out here.
APT_CFG=()
if grep -qsE '^[[:space:]]*deb[[:space:]]+(\[[^]]*\][[:space:]]+)?cdrom:' /etc/apt/sources.list; then
  APT_SOURCES="$(mktemp)"
  grep -vE '^[[:space:]]*deb[[:space:]]+(\[[^]]*\][[:space:]]+)?cdrom:' /etc/apt/sources.list >"$APT_SOURCES" || true
  APT_CFG=(-o "Dir::Etc::SourceList=$APT_SOURCES")
  note "Leaving the install disc out of the package sources"
fi
# Configuration files someone changed stay as they are; a daily update holding the package lock is waited for.
APT=(apt-get "${APT_CFG[@]}" -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
apt_install() {
  local log
  log="$(mktemp)"
  if ! "${APT[@]}" install -y -q --no-install-recommends "$@" >"$log" 2>&1; then
    tail -n 25 "$log" >&2
    rm -f "$log"
    die "Could not install $* (the lines above say why). Check that this server reaches the internet, then run the installer again."
  fi
  rm -f "$log"
}
"${APT[@]}" update -qq || die "Could not read the package lists. Check that this server reaches the internet (and its name servers), then run the installer again."
apt_install pciutils ca-certificates curl xz-utils openssl iproute2
if has_role virtual; then
  say "Installing the hypervisor (QEMU/KVM, libvirt, UEFI firmware, software TPM)"
  apt_install qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients ovmf swtpm swtpm-tools \
    dnsmasq-base bridge-utils irqbalance
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
  if apt-cache "${APT_CFG[@]}" show systemd-networkd >/dev/null 2>&1; then GATE_PKGS="$GATE_PKGS systemd-networkd"; fi
  # shellcheck disable=SC2086
  apt_install $GATE_PKGS
fi
if has_role time; then
  say "Installing FBRX Time's tools (the backup folder for computers: Samba)"
  apt_install samba qemu-utils
fi
if has_role ai; then
  # The built-in AI runtime (llama.cpp, downloaded from the console's Mesh & AI → Models) needs OpenMP; with a graphics
  # card it runs through Vulkan. NVIDIA cards also need NVIDIA's own driver (Debian's non-free nvidia-driver).
  AI_PKGS="libgomp1"
  if lspci 2>/dev/null | grep -qiE '(vga|3d|display).*(nvidia|amd|ati|radeon|intel)'; then AI_PKGS="$AI_PKGS libvulkan1 mesa-vulkan-drivers"; fi
  say "Installing what the built-in AI runtime needs ($AI_PKGS)"
  # shellcheck disable=SC2086
  apt_install $AI_PKGS
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
  # The graphics cards, for the built-in AI runtime (nothing else of the system).
  for g in render video; do
    if getent group "$g" >/dev/null; then usermod -aG "$g" "$CORE_USER"; fi
  done
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
  set_env FBRX_V_GATE_LAN_ADDRESS "$GATE_LAN_ADDRESS"
  set_env FBRX_V_GATE_WAN_ADDRESS "$GATE_WAN_ADDRESS"
  set_env FBRX_V_GATE_WAN_GATEWAY "$GATE_WAN_GATEWAY"
  # The first start puts the starter configuration in place (once: later starts apply what was committed).
  set_env FBRX_V_GATE_FIRST commit
  # The question log (MiniDome reads it) is rotated daily. dnsmasq reopens it on USR2 as its own user, so the new file
  # keeps the old one's owner ("create" without attributes).
  cat >/etc/logrotate.d/fbrx-gate <<EOF
$GATE_LOG/dnsmasq.log {
    daily
    rotate 7
    create
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
  mkdir -p /etc/systemd/networkd.conf.d /etc/systemd/network
  printf '%s\n' '[Network]' 'ManageForeignRoutes=no' 'ManageForeignRoutingPolicyRules=no' >/etc/systemd/networkd.conf.d/fbrx-gate.conf
  # The internet port from the first start on, before FBRX Gate's first commit (which writes the same file and the
  # rest): the server reaches the internet even if that commit waits, and the start does not hang waiting for a network.
  WAN_FILE="/etc/systemd/network/10-fbrx-$GATE_WAN.network"
  if [ ! -f "$WAN_FILE" ]; then
    {
      printf '%s\n' '# Made by FBRX Gate from its configuration: changes here are overwritten.' '[Match]' "Name=$GATE_WAN" '' '[Link]' 'MTUBytes=1500' '' '[Network]'
      if [ -n "$GATE_WAN_ADDRESS" ]; then printf '%s\n' "Address=$GATE_WAN_ADDRESS" "Gateway=$GATE_WAN_GATEWAY" 'IPv6AcceptRA=no' 'LinkLocalAddressing=no'
      else printf '%s\n' 'DHCP=ipv4' 'IPv6AcceptRA=no' 'LinkLocalAddressing=no' '' '[DHCPv4]' 'UseDNS=no' 'UseNTP=yes'; fi
    } >"$WAN_FILE"
  fi
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

# ---------------------------------------------------------------------------------------- time role

TIME_DIR=/var/lib/fbrx-time
TIME_ETC=/etc/fbrx-time
TIME_SMB=/etc/samba/fbrx-time.conf
if has_role time; then
  say "Setting up FBRX Time (images in $TIME_DIR, a backup folder for computers)"
  mkdir -p "$TIME_DIR/images" "$TIME_DIR/incoming" "$TIME_DIR/lab" "$TIME_ETC"
  chmod 0755 "$TIME_DIR"
  chmod 0700 "$TIME_ETC"
  # Computers sign in to the backup folder with an account of its own (no login on the server).
  if ! id fbrx-time >/dev/null 2>&1; then useradd --system --no-create-home --home-dir "$TIME_DIR/incoming" --shell /usr/sbin/nologin fbrx-time; fi
  chown fbrx-time:fbrx-time "$TIME_DIR/incoming"
  chmod 0770 "$TIME_DIR/incoming"
  # Its password: made once; the console shows it (and a one-line connection code) to administrators.
  if [ ! -s "$TIME_ETC/share.env" ]; then
    TIME_PW="$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' | cut -c1-24)"
    printf 'SHARE_NAME=fbrx-time\nSHARE_USER=fbrx-time\nSHARE_PASSWORD=%s\n' "$TIME_PW" >"$TIME_ETC/share.env"
  fi
  chmod 0600 "$TIME_ETC/share.env"
  TIME_PW="$(sed -n 's/^SHARE_PASSWORD=//p' "$TIME_ETC/share.env")"
  if command -v smbpasswd >/dev/null; then
    printf '%s\n%s\n' "$TIME_PW" "$TIME_PW" | smbpasswd -s -a fbrx-time >/dev/null || warn "Could not set the backup folder's password (smbpasswd)"
    smbpasswd -e fbrx-time >/dev/null 2>&1 || true
  fi
  cat >"$TIME_SMB" <<SMB
# FBRX Time: the folder computers send their image backups to (written by the FBRX Server installer).
[fbrx-time]
   comment = FBRX Time backups
   path = $TIME_DIR/incoming
   valid users = fbrx-time
   force user = fbrx-time
   read only = no
   browseable = yes
   create mask = 0660
   directory mask = 0770
   smb encrypt = desired
SMB
  if [ -f /etc/samba/smb.conf ] && ! grep -q "include = $TIME_SMB" /etc/samba/smb.conf; then
    printf '\n# FBRX Time\ninclude = %s\n' "$TIME_SMB" >>/etc/samba/smb.conf
  fi
elif [ -f "$TIME_SMB" ]; then
  say "Turning FBRX Time off (its images stay in $TIME_DIR)"
  rm -f "$TIME_SMB"
  if [ -f /etc/samba/smb.conf ]; then sed -i "\|^# FBRX Time\$|d; \|^include = $TIME_SMB\$|d" /etc/samba/smb.conf; fi
  if ! in_chroot; then systemctl reload smbd.service 2>/dev/null || true; fi
fi

# ------------------------------------------------------------------------------------------ command role

cmd_existing() { (grep -E "^$1=" "$CMD_ETC/fbrx-command.env" 2>/dev/null || true) | tail -1 | cut -d= -f2-; }
set_cmd() {
  if grep -q "^$1=" "$CMD_ETC/fbrx-command.env"; then sed -i "s|^$1=.*|$1=$2|" "$CMD_ETC/fbrx-command.env"; else printf '%s=%s\n' "$1" "$2" >>"$CMD_ETC/fbrx-command.env"; fi
}
CMD_PORT="$(cmd_existing FBRX_CP_PORT)"
CMD_PORT="${CMD_PORT:-8787}"
CMD_URL=""
if has_role command; then
  say "Installing FBRX Command (command role)"
  rm -rf "$APP/fbrx-command.new"
  cp -r "$BUNDLE/fbrx-command" "$APP/fbrx-command.new"
  rm -rf "$APP/fbrx-command"
  mv "$APP/fbrx-command.new" "$APP/fbrx-command"
  chmod -R go-w "$APP/fbrx-command"
  # Its own account, with no login and no special rights.
  if ! id "$CMD_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$CMD_DATA" --no-create-home --shell /usr/sbin/nologin "$CMD_USER"
  fi
  mkdir -p "$CMD_DATA" "$CMD_ETC"
  chown "$CMD_USER:$CMD_USER" "$CMD_DATA"
  chmod 0700 "$CMD_DATA"
  chmod 0755 "$CMD_ETC"
  install -m 0644 "$BUNDLE/fbrx-command.service" "$CMD_UNIT"
  if [ ! -f "$CMD_ETC/fbrx-command.env" ]; then
    # The address computers use: the one given, the gate's on a gate (computers sit behind it), else this server's.
    CMD_HOST="$CMD_ADDRESS"
    if [ -z "$CMD_HOST" ] && has_role gate; then CMD_HOST="$GATE_LAN_IP"; fi
    if [ -z "$CMD_HOST" ] && ! in_chroot; then CMD_HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"; fi
    CMD_HOST="${CMD_HOST:-$(hostname)}"
    cat >"$CMD_ETC/fbrx-command.env" <<EOF
# FBRX Command on FBRX Server (sudo systemctl restart fbrx-command after a change). See docs/SERVER.md.
FBRX_CP_PORT=$CMD_PORT
FBRX_CP_HOST=0.0.0.0
FBRX_CP_DATA_DIR=$CMD_DATA
# The address computers and people use. Give the server a fixed address in your router, or a name in your DNS
# (the installer's --command-address changes it).
FBRX_CP_PUBLIC_URL=https://$CMD_HOST:$CMD_PORT
# HTTPS with its own certificate, made once in $CMD_DATA/tls: computers check its fingerprint when they join.
FBRX_CP_TLS=self-signed
FBRX_CP_TLS_NAMES=$CMD_HOST
# The server's console checks on it here (this computer only).
FBRX_CP_LOCAL_PORT=$((CMD_PORT + 1))
# New versions come with FBRX Server (sudo fbrx-server update).
FBRX_CP_MANAGED_BY=fbrx-server
# Secrets (the setup token, an e-mail server's password…) go in secrets.env next to this file, which only root reads.
EOF
  elif [ -n "$CMD_ADDRESS" ]; then
    set_cmd FBRX_CP_PUBLIC_URL "https://$CMD_ADDRESS:$CMD_PORT"
    set_cmd FBRX_CP_TLS_NAMES "$CMD_ADDRESS"
    note "Computers reach FBRX Command at https://$CMD_ADDRESS:$CMD_PORT from now on (ones that joined before keep the old address)."
  else
    note "Kept FBRX Command's settings in $CMD_ETC/fbrx-command.env"
  fi
  chmod 0644 "$CMD_ETC/fbrx-command.env"
  # The first sign-in asks for the setup token (sudo fbrx-server command shows it until FBRX Command is set up).
  if [ ! -s "$CMD_ETC/secrets.env" ]; then
    printf '# FBRX Command settings only root may read. See fbrx-command.env.\nFBRX_CP_SETUP_TOKEN=%s\n' "$(head -c 18 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" >"$CMD_ETC/secrets.env"
  fi
  chmod 0600 "$CMD_ETC/secrets.env"
  CMD_URL="$(cmd_existing FBRX_CP_PUBLIC_URL)"
  # The server's console reads its status on the local-only port.
  set_env FBRX_V_COMMAND_URL "http://127.0.0.1:$(cmd_existing FBRX_CP_LOCAL_PORT)"
elif [ -f "$CMD_UNIT" ]; then
  say "Turning FBRX Command off (its data stays in $CMD_DATA)"
  systemctl disable --now fbrx-command.service 2>/dev/null || true
  rm -f "$CMD_UNIT" /etc/systemd/system/multi-user.target.wants/fbrx-command.service
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

# ------------------------------------------------------------------------------- the installer, kept

# A copy of this bundle stays on the server (without the Node.js archive), so roles can be changed later from the
# console's Roles page or with sudo fbrx-server roles add <role>, without the bundle at hand.
if [ "$BUNDLE" != "$APP/bundle" ]; then
  rm -rf "$APP/bundle.new"
  mkdir -p "$APP/bundle.new"
  find "$BUNDLE" -mindepth 1 -maxdepth 1 ! -name 'node-v*' -exec cp -a {} "$APP/bundle.new/" \;
  rm -rf "$APP/bundle"
  mv "$APP/bundle.new" "$APP/bundle"
  chmod -R go-w "$APP/bundle"
fi

# ------------------------------------------------------------------------------------ screen and motd

[ -f /etc/issue ] && [ ! -f /etc/issue.fbrx-backup ] && cp /etc/issue /etc/issue.fbrx-backup
# The account made while installing (the ISO suggests "fbrx"): the login screen says which one to use.
ADMIN_USER="$(getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 && $7 !~ /(nologin|false)$/ { print $1; exit }' || true)"
SIGN_IN="${ADMIN_USER:+Sign in here as $ADMIN_USER (the password you chose while installing); it uses sudo.}"
if has_role gate; then
  cat >/etc/issue <<EOF
FBRX Server $VERSION · powered by FBRX OS  (\n, \l)

FBRX Gate: the internet on $GATE_WAN, your network on $GATE_LAN.
Open the console from a computer on your network:  https://$GATE_LAN_IP:$PORT
(or https://\4:$PORT${GATE_MANAGE:+ from $GATE_MANAGE})
$SIGN_IN

EOF
else
  cat >/etc/issue <<EOF
FBRX Server $VERSION · powered by FBRX OS  (\n, \l)

Open the FBRX Virtual console from another computer:  https://\4:$PORT
$SIGN_IN

EOF
fi
if has_role command; then printf 'FBRX Command for your organization:  %s\n\n' "$CMD_URL" >>/etc/issue; fi
mkdir -p /etc/issue.d
ln -sf "$DATA/setup-code.issue" /etc/issue.d/fbrx-virtual-setup.issue
mkdir -p /etc/motd.d 2>/dev/null || true
cat >/etc/motd.d/fbrx-server 2>/dev/null <<EOF || true

  FBRX Server · powered by FBRX OS
  fbrx-server status   where the console is, and how things are
  fbrx-server help     everything else
$(with_role gate '  fbrx-gate status     the gate: ports, devices, problems (fbrx-gate help: the rest)')
$(with_role command '  fbrx-server command  FBRX Command: its address, certificate and setup token')
EOF

# ---------------------------------------------------------------------------------------------- start

systemctl daemon-reload 2>/dev/null || true
mkdir -p /etc/systemd/system/multi-user.target.wants
systemctl enable fbrx-virtual.service >/dev/null 2>&1 || ln -sf "$UNIT" /etc/systemd/system/multi-user.target.wants/fbrx-virtual.service
if has_role ai; then systemctl enable fbrx-core.service >/dev/null 2>&1 || ln -sf "$CORE_UNIT" /etc/systemd/system/multi-user.target.wants/fbrx-core.service; fi
if has_role command; then systemctl enable fbrx-command.service >/dev/null 2>&1 || ln -sf "$CMD_UNIT" /etc/systemd/system/multi-user.target.wants/fbrx-command.service; fi
if has_role time; then systemctl enable smbd.service >/dev/null 2>&1 || true; fi
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
  if has_role command; then systemctl restart fbrx-command.service || warn "FBRX Command did not start (journalctl -u fbrx-command)"; fi
  if has_role time; then systemctl restart smbd.service || warn "Samba did not start: computers cannot reach the backup folder (journalctl -u smbd)"; fi
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
  note "Enabled: the console$(with_role ai ', the FBRX core')$(with_role command ', FBRX Command')$(with_role gate ' and FBRX Gate') start with the server."
fi

echo
say "FBRX Server is installed."
if has_role gate; then
  note "Plug a computer into $GATE_LAN: it gets an address. Open https://$GATE_LAN_IP:$PORT and sign in with the setup code (fbrx-server setup-code)."
else
  note "Open https://<this server>:$PORT and sign in with the setup code (fbrx-server setup-code)."
fi
note "Your browser warns about the certificate the first time: compare it with fbrx-server fingerprint."
if has_role ai; then note "Then open Mesh & AI in the console: under Models on this server, download a model that fits and use it (or pick a provider), and pair the server with your other computers."; fi
if has_role gate; then note "The Gate pages (or fbrx-gate on this server) change networks, VLANs, the firewall, the VPN and Prefer Mesh: edit, review, commit."; fi
if has_role command; then
  note "FBRX Command: open $CMD_URL and set it up with its setup token (fbrx-server command shows both). Your browser warns about its certificate the first time: compare it with fbrx-server command."
  if has_role gate && [ "$GATE_NEW" -eq 0 ]; then note "On this gate, let your network reach it: a firewall rule from your network to the gate, TCP $CMD_PORT (the console's FBRX Command page says when it is missing)."; fi
fi
if has_role time; then note "FBRX Time in the console: back up virtual machines on a schedule, and connect computers to the backup folder (its connection code is there).$(with_role gate ' On a gate, let your network reach it: a firewall rule for TCP 445 to the gate.')"; fi
# Everything that should run, runs (fbrx-server doctor --fix switches on whatever is off).
if [ "$START" -eq 1 ] && ! in_chroot; then /usr/local/sbin/fbrx-server doctor --quiet || note "sudo fbrx-server doctor --fix switches on what is off."; fi
if [ "$REBOOT_NEEDED" -eq 1 ]; then
  note "Restart the server once (sudo reboot) for ${REBOOT_WHY:-the changes}."
  if [ "$NO_START" -eq 0 ] && ! in_chroot && { [ "$REBOOT" -eq 1 ] || { [ "$YES" -eq 0 ] && [ -t 0 ] && confirm "Restart now?"; }; }; then
    say "Restarting"
    systemctl reboot
  fi
fi
