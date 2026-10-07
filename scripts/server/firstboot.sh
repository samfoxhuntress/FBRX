#!/usr/bin/env bash
# FBRX Server's first start after the ISO. The Debian installer only copies FBRX Server to /opt/fbrx-installer (it
# runs in a stripped-down environment where installing packages and services is fragile); this finishes the setup on
# the running system, with the network up, showing its progress on the screen before the login prompt. Then it
# switches itself off. If it stopped (no internet, say), run it again:
#
#   sudo bash /opt/fbrx-installer/firstboot.sh
#
# It also tries again at the next start until it finishes.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG=/var/log/fbrx-server-install.log
NOTE=/etc/issue.d/fbrx-server-firstboot.issue
UNIT=fbrx-server-firstboot.service
# The roles to set up (the ISO's default; a "roles" file next to this script changes them).
ROLES="$(tr -d ' \n' <"$DIR/roles" 2>/dev/null || true)"
ROLES="${ROLES:-virtual,ai}"

[ "$(id -u)" -eq 0 ] || { echo "Run this as root: sudo bash $0" >&2; exit 1; }
mkdir -p /etc/issue.d

echo
echo "FBRX Server is finishing its setup. It takes a few minutes and needs the internet; the login prompt follows."
echo "Everything is also written to $LOG."
echo

# The network comes up during start-up: wait (up to two minutes) until names resolve, so apt finds its mirror.
for _ in $(seq 1 60); do
  if getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done

{ echo; echo "---- $(date -Is) first-start setup (roles $ROLES)"; } >>"$LOG"
if bash "$DIR/install.sh" --bundle "$DIR" --yes --roles "$ROLES" 2>&1 | tee -a "$LOG"; then
  rm -f "$NOTE"
  systemctl disable "$UNIT" >/dev/null 2>&1 || true
  exit 0
fi

cat >"$NOTE" <<EOF
FBRX Server's setup did not finish: the reason is at the end of $LOG.
Sign in, check the internet (ping -c1 deb.debian.org), then run:  sudo bash $DIR/firstboot.sh
(It also tries again at the next start.)

EOF
echo
echo "FBRX Server's setup did not finish. The login screen says how to try again."
exit 1
