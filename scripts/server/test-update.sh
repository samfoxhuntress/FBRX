#!/usr/bin/env bash
# Test of fbrx-server update commit / rollback, in a throwaway folder standing in for the server: fbrx-server's paths
# point into it, and systemctl and curl are stand-ins. A staged bundle whose installer works is installed and rolled
# back; one whose installer fails, and one that never answers, are rolled back by themselves.
#
#   scripts/server/test-update.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="$(mktemp -d)"
trap 'rm -rf "$R"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$R/bin" "$R/opt/fbrx-server/fbrx-virtual" "$R/etc/fbrx-virtual" "$R/var/lib/fbrx-virtual" "$R/usr/local/sbin" "$R/etc/systemd/system" "$R/var/log" "$R/state"
echo "old" >"$R/opt/fbrx-server/fbrx-virtual/marker"
printf 'NAME="FBRX Server"\nVERSION="0.1.0"\nROLES="virtual,ai"\n' >"$R/etc/fbrx-server-release"
printf 'FBRX_V_PORT=9443\nFBRX_V_ROLES=virtual,ai\n' >"$R/etc/fbrx-virtual/fbrx-virtual.env"
echo "old data" >"$R/var/lib/fbrx-virtual/virtual.db"
echo "[Unit]" >"$R/etc/systemd/system/fbrx-virtual.service"

# Stand-ins: systemctl remembers nothing; curl answers when the state file says the console is up.
printf '#!/usr/bin/env bash\necho "systemctl $*" >>"%s/state/systemctl.log"\nexit 0\n' "$R" >"$R/bin/systemctl"
# shellcheck disable=SC2016 # the stand-in reads the state file when it runs
printf '#!/usr/bin/env bash\n[ "$(cat "%s/state/up" 2>/dev/null)" = yes ]\n' "$R" >"$R/bin/curl"
printf '#!/usr/bin/env bash\nexit 0\n' >"$R/bin/sleep"
chmod +x "$R/bin/"*

# fbrx-server with its paths in the throwaway folder (and no root check).
sed -e "s|/opt/fbrx-server|$R/opt/fbrx-server|g; s|/var/lib/fbrx-virtual|$R/var/lib/fbrx-virtual|g; s|/etc/fbrx-virtual|$R/etc/fbrx-virtual|g" \
  -e "s|/etc/fbrx-server-release|$R/etc/fbrx-server-release|g; s|/var/lib/fbrx-server-update|$R/var/lib/fbrx-server-update|g" \
  -e "s|/var/log/fbrx-server-update.log|$R/var/log/fbrx-server-update.log|g; s|/usr/local/sbin|$R/usr/local/sbin|g" \
  -e "s|/etc/systemd/system|$R/etc/systemd/system|g; s|/etc/fbrx-core|$R/etc/fbrx-core|g; s|/var/lib/fbrx-core|$R/var/lib/fbrx-core|g" \
  -e 's|^need_root() {.*|need_root() { :; }|' \
  "$HERE/fbrx-server" >"$R/fbrx-server"
cp "$R/fbrx-server" "$R/usr/local/sbin/fbrx-server"
fbrx_server() { PATH="$R/bin:$PATH" bash "$R/fbrx-server" "$@" </dev/null; }

# A staged bundle: its installer replaces the program, the version and the database, like install.sh does.
stage() {
  local version=$1 outcome=$2 b="$R/var/lib/fbrx-server-update/staged/fbrx-server-$1"
  mkdir -p "$b"
  cat >"$b/install.sh" <<EOF
#!/usr/bin/env bash
set -e
case " \$* " in *" --roles virtual,ai "*) ;; *) echo "install.sh was not given this server's roles: \$*" >&2; exit 9 ;; esac
echo "new $version" >"$R/opt/fbrx-server/fbrx-virtual/marker"
sed -i 's/^VERSION=.*/VERSION="$version"/' "$R/etc/fbrx-server-release"
echo "migrated for $version" >"$R/var/lib/fbrx-virtual/virtual.db"
case "$outcome" in fails) echo "something broke" >&2; exit 1 ;; silent) echo no >"$R/state/up" ;; *) echo yes >"$R/state/up" ;; esac
EOF
  printf 'VERSION=%s\nBUNDLE=%s\nFROM=test\nSHA256=x\nSUMMARY=Test\nSTAGED_AT=now\n' "$version" "$b" >"$R/var/lib/fbrx-server-update/staged.env"
}
version_is() { grep -q "^VERSION=\"$1\"" "$R/etc/fbrx-server-release" || fail "expected version $1, have $(cat "$R/etc/fbrx-server-release")"; }

echo "== nothing staged"
if fbrx_server update commit --yes 2>/dev/null; then fail "commit without a staged update"; fi
fbrx_server update | grep -q 'Ready:      nothing' || fail "status without a staged update"

echo "== update commit"
echo yes >"$R/state/up"
stage 0.1.1 works
fbrx_server update | grep -q 'Ready:      0.1.1' || fail "status does not show the staged update"
fbrx_server update commit --yes >/dev/null || fail "commit of a working update"
version_is 0.1.1
grep -q 'new 0.1.1' "$R/opt/fbrx-server/fbrx-virtual/marker" || fail "the new program is not in place"
[ ! -e "$R/var/lib/fbrx-server-update/staged.env" ] || fail "the staged update was not cleared"
grep -q 'old data' "$R/var/lib/fbrx-server-update/previous/data/virtual.db" || fail "the database was not kept aside"
fbrx_server update | grep -q 'Previous:   0.1.0' || fail "status does not show the previous version"

echo "== update rollback"
fbrx_server update rollback --yes >/dev/null || fail "rollback"
version_is 0.1.0
grep -q 'old' "$R/opt/fbrx-server/fbrx-virtual/marker" || fail "the old program did not come back"
grep -q 'old data' "$R/var/lib/fbrx-virtual/virtual.db" || fail "the old database did not come back"

echo "== an installer that fails goes back by itself"
stage 0.1.2 fails
if fbrx_server update commit --yes >/dev/null 2>&1; then fail "a failed install reported success"; fi
version_is 0.1.0
grep -q 'old' "$R/opt/fbrx-server/fbrx-virtual/marker" || fail "not back on the old program after a failed install"
grep -q 'old data' "$R/var/lib/fbrx-virtual/virtual.db" || fail "not back on the old database after a failed install"
[ -e "$R/var/lib/fbrx-server-update/staged.env" ] || fail "the update that failed should stay ready to try again"

echo "== a version that never answers goes back by itself"
stage 0.1.3 silent
if fbrx_server update commit --yes >/dev/null 2>&1; then fail "a silent install reported success"; fi
version_is 0.1.0

echo "OK: fbrx-server update commit installs, keeps the previous version, rolls back on request and by itself"
