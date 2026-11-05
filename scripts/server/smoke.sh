#!/usr/bin/env bash
# Smoke test of a built FBRX Server bundle without installing it: starts the FBRX core in server mode (the ai role)
# and FBRX Virtual (simulated hypervisor) next to each other, as on a server, and checks that the console reaches the
# core with the console token. Then FBRX Virtual as a gate (simulated), driven by the bundled fbrx-gate command line,
# and FBRX Command (the command role) as the installer sets it up, seen from the server console.
# Uses the core's usual Local API port (47821), so nothing else may be listening there.
#   scripts/server/smoke.sh dist/fbrx-server-<version>
set -euo pipefail

BUNDLE="$(cd "${1:?Usage: smoke.sh <unpacked bundle folder>}" && pwd)"
NODE="${NODE:-node}"
WORK="$(mktemp -d)"
V_PORT="${V_PORT:-9556}"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  echo "--- core log" >&2
  tail -n 40 "$WORK/core.log" >&2 || true
  echo "--- FBRX Virtual log" >&2
  tail -n 40 "$WORK/virtual.log" >&2 || true
  exit 1
}
wait_for() {
  for _ in $(seq 1 60); do
    if eval "$1"; then return 0; fi
    sleep 0.5
  done
  return 1
}
json() { "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(String($1))})"; }

echo "==> FBRX core (server mode)"
mkdir -p "$WORK/core"
"$NODE" "$BUNDLE/fbrx-core/core.mjs" run --server --data-dir "$WORK/core" --roles virtual,ai --console-token-file "$WORK/core/console.token" >"$WORK/core.log" 2>&1 &
PIDS+=($!)
wait_for "[ -s '$WORK/core/console.token' ]" || fail "the core wrote no console token"
[ "$(stat -c %a "$WORK/core/console.token")" = "600" ] || fail "the console token is not private (mode $(stat -c %a "$WORK/core/console.token"))"
CORE_URL="$(grep -oE 'Local API: http://127\.0\.0\.1:[0-9]+' "$WORK/core.log" | head -1 | cut -d' ' -f3)"
[ -n "$CORE_URL" ] || CORE_URL="http://127.0.0.1:47821"
wait_for "curl -fs '$CORE_URL/v1/health' >/dev/null" || fail "the core's Local API does not answer at $CORE_URL"
echo "    core at $CORE_URL"

echo "==> FBRX Virtual"
FBRX_V_DRIVER=simulated FBRX_V_TLS=off FBRX_V_HOST=127.0.0.1 FBRX_V_PORT="$V_PORT" FBRX_V_DATA_DIR="$WORK/virtual" \
  FBRX_V_ADMIN_USER=smoke FBRX_V_ADMIN_PASSWORD=smoke-test-password FBRX_V_LOG_LEVEL=warn \
  FBRX_V_CORE_URL="$CORE_URL" FBRX_V_CORE_TOKEN_FILE="$WORK/core/console.token" FBRX_V_CONSOLE_DIR="$BUNDLE/fbrx-virtual/virtual-console" \
  "$NODE" "$BUNDLE/fbrx-virtual/server.mjs" >"$WORK/virtual.log" 2>&1 &
PIDS+=($!)
V="http://127.0.0.1:$V_PORT"
wait_for "curl -fs '$V/healthz' >/dev/null" || fail "FBRX Virtual does not answer"
TOKEN="$(curl -fs -H 'content-type: application/json' -d '{"username":"smoke","password":"smoke-test-password"}' "$V/v1/auth/login" | json 'v.token')"
AUTH=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

STATE="$(curl -fs "${AUTH[@]}" "$V/v1/core")"
[ "$(json 'v.installed && v.running' <<<"$STATE")" = "true" ] || fail "FBRX Virtual does not see the core: $STATE"
ROLES="$(curl -fs "${AUTH[@]}" -d '{"method":"settings.get"}' "$V/v1/core/call" | json 'v.result.settings.mesh.assist.roles.join(",")')"
[ "$ROLES" = "virtual,ai" ] || fail "the core announces roles '$ROLES'"
MESH="$(curl -fs "${AUTH[@]}" -d '{"method":"mesh.status"}' "$V/v1/core/call" | json 'v.result.enabled')"
[ "$MESH" = "true" ] || fail "FBRX Mesh is not on in server mode"
curl -fs "${AUTH[@]}" -d '{"method":"settings.update","params":{"patch":{"mesh":{"assist":{"offer":"auto","controller":true}}}}}' "$V/v1/core/call" >/dev/null || fail "an administrator could not change Mesh Assist"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -d '{"method":"vault.reveal","params":{"name":"x"}}' "$V/v1/core/call")"
[ "$STATUS" = "403" ] || fail "the console could call vault.reveal ($STATUS)"
echo "OK: the FBRX core runs in server mode and FBRX Virtual manages it (roles $ROLES, mesh on)"

echo "==> FBRX Gate (the gate role, simulated) and its command line"
G_PORT=$((V_PORT + 1))
GATE_ENV=("FBRX_V_ROLES=gate,minidome" FBRX_V_GATE=simulated FBRX_V_GATE_WAN=eno1 FBRX_V_GATE_LAN=eno2 FBRX_V_GATE_FIRST=commit FBRX_V_TLS=off FBRX_V_HOST=127.0.0.1 FBRX_V_PORT="$G_PORT" FBRX_V_DATA_DIR="$WORK/gate" FBRX_V_LOG_LEVEL=warn FBRX_V_CONSOLE_DIR="$BUNDLE/fbrx-virtual/virtual-console")
env "${GATE_ENV[@]}" "$NODE" "$BUNDLE/fbrx-virtual/server.mjs" >"$WORK/gate.log" 2>&1 &
PIDS+=($!)
wait_for "[ -s '$WORK/gate/cli.token' ] && curl -fs 'http://127.0.0.1:$G_PORT/healthz' >/dev/null" || { cat "$WORK/gate.log" >&2; fail "FBRX Virtual as a gate does not answer"; }
gate() { env "${GATE_ENV[@]}" NO_COLOR=1 "$NODE" "$BUNDLE/fbrx-virtual/gate-cli.mjs" "$@"; }
gate history | grep -q 'Starter configuration' || fail "the starter configuration was not committed at the first start: $(gate history)"
gate add networks '{"name":"guest","purpose":"guest","interface":"eno2.20","address":"192.168.20.1/24","access":"internet","manage":false,"dhcp":{"enabled":true,"start":"192.168.20.100","end":"192.168.20.199","leaseHours":12,"reservations":[]}}' >/dev/null
gate check | grep -q 'There is no interface eno2.20' || fail "fbrx-gate check did not find the missing VLAN: $(gate check)"
gate add interfaces '{"name":"eno2.20","kind":"vlan","parent":"eno2","vlanId":20,"mtu":1500}' >/dev/null
gate set qos preferMesh networks guest >/dev/null
gate compare | grep -q 'networks.guest' || fail "fbrx-gate compare does not show the new network: $(gate compare)"
gate commit confirmed 5 comment smoke test | grep -q 'rolls back' || fail "fbrx-gate commit confirmed did not ask for a confirmation"
gate confirm | grep -q 'confirmed' || fail "fbrx-gate confirm"
gate preview nftables | grep -q 'iifname "eno2.20" ip dscp set af41' || fail "the guest network is not marked for Prefer Mesh in the firewall"
gate status >/dev/null || fail "fbrx-gate status"
gate renumber lan 192.168.50.1/24 >/dev/null || fail "fbrx-gate renumber"
gate show networks lan dhcp start | grep -q '192.168.50.100' || fail "fbrx-gate renumber did not move the range: $(gate show networks lan)"
gate wan static 203.0.113.2/29 203.0.113.1 >/dev/null || fail "fbrx-gate wan static"
gate preview networkd | grep -q 'Gateway=203.0.113.1' || fail "the fixed internet address is not in the port settings"
gate reset >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $(cat "$WORK/gate/cli.token")" "http://127.0.0.1:$G_PORT/v1/gate")" = "200" ] || fail "the command line's token is not accepted from this computer"
DOME="$(curl -fs -H "authorization: Bearer $(cat "$WORK/gate/cli.token")" "http://127.0.0.1:$G_PORT/v1/dome")" || fail "FBRX MiniDome does not answer"
[ "$(json 'v.mode + " " + v.settings.enabled' <<<"$DOME")" = "simulated true" ] || fail "FBRX MiniDome is not watching: $DOME"
echo "OK: FBRX Gate commits, confirms and previews from the bundled command line; FBRX MiniDome watches it"

echo "==> FBRX Command (the command role), from the bundle, as the installer sets it up"
C_PORT=$((V_PORT + 2))
C_LOCAL="http://127.0.0.1:$((C_PORT + 1))"
mkdir -p "$WORK/command"
printf 'FBRX_CP_PORT=%s\nFBRX_CP_PUBLIC_URL=https://127.0.0.1:%s\nFBRX_CP_LOCAL_PORT=%s\n' "$C_PORT" "$C_PORT" "$((C_PORT + 1))" >"$WORK/command.env"
printf 'FBRX_CP_SETUP_TOKEN=smoke-setup-token\n' >"$WORK/secrets.env"
(
  set -a
  # shellcheck disable=SC1091
  . "$WORK/command.env"
  # shellcheck disable=SC1091
  . "$WORK/secrets.env"
  set +a
  FBRX_CP_HOST=127.0.0.1 FBRX_CP_DATA_DIR="$WORK/command" FBRX_CP_TLS=self-signed FBRX_CP_MANAGED_BY=fbrx-server FBRX_CP_UPDATE_CHECK=off \
    FBRX_CP_LOG_LEVEL=warn FBRX_ADMIN_CONSOLE_DIR="$BUNDLE/fbrx-command/admin-console" exec "$NODE" "$BUNDLE/fbrx-command/server.mjs"
) >"$WORK/command.log" 2>&1 &
PIDS+=($!)
wait_for "curl -fs '$C_LOCAL/v1/setup/status' >/dev/null" || { cat "$WORK/command.log" >&2; fail "FBRX Command from the bundle does not answer"; }
curl -fs "$C_LOCAL/" | grep -q '<div id="root">' || fail "FBRX Command does not serve its console"
FP="$(openssl x509 -in "$WORK/command/tls/command.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
S_PORT=$((V_PORT + 4))
FBRX_V_ROLES=command FBRX_V_TLS=off FBRX_V_HOST=127.0.0.1 FBRX_V_PORT="$S_PORT" FBRX_V_DATA_DIR="$WORK/command-console" FBRX_V_LOG_LEVEL=warn \
  FBRX_V_ADMIN_USER=smoke FBRX_V_ADMIN_PASSWORD=smoke-test-password FBRX_V_CORE_TOKEN_FILE="$WORK/none.token" FBRX_V_CONSOLE_DIR="$BUNDLE/fbrx-virtual/virtual-console" \
  FBRX_V_COMMAND_ENV="$WORK/command.env" FBRX_V_COMMAND_SECRETS="$WORK/secrets.env" FBRX_V_COMMAND_CERT="$WORK/command/tls/command.crt" FBRX_V_COMMAND_URL="$C_LOCAL" \
  "$NODE" "$BUNDLE/fbrx-virtual/server.mjs" >"$WORK/command-console.log" 2>&1 &
PIDS+=($!)
S="http://127.0.0.1:$S_PORT"
wait_for "curl -fs '$S/healthz' >/dev/null" || { cat "$WORK/command-console.log" >&2; fail "FBRX Virtual with the command role does not answer"; }
STOKEN="$(curl -fs -H 'content-type: application/json' -d '{"username":"smoke","password":"smoke-test-password"}' "$S/v1/auth/login" | json 'v.token')"
SEEN="$(curl -fs -H "authorization: Bearer $STOKEN" "$S/v1/server/command")"
[ "$(json '[v.enabled, v.running, v.needsSetup, v.setupToken].join(" ")' <<<"$SEEN")" = "true true true smoke-setup-token" ] || fail "the console does not see FBRX Command waiting to be set up: $SEEN"
[ "$(json 'v.fingerprint' <<<"$SEEN")" = "$FP" ] || fail "the console shows another certificate than FBRX Command's: $SEEN"
echo "OK: FBRX Command runs from the bundle with its own certificate, and the server console shows it"

echo "==> fbrx-server update check (the bundled helper)"
VERSION_NOW="$(cat "$BUNDLE/VERSION")"
printf 'VERSION="%s"\n' "$VERSION_NOW" >"$WORK/release"
upd() { env FBRX_V_DATA_DIR="$WORK/upd-data" FBRX_SERVER_UPDATE_DIR="$WORK/update" FBRX_SERVER_RELEASE_FILE="$WORK/release" "$NODE" "$BUNDLE/fbrx-virtual/cli.mjs" update-check "$@"; }
mkdir -p "$WORK/upd-data"
printf '{"server":{"version":"%s","bundle":"https://example.invalid/fbrx-server.tar.gz"}}\n' "$VERSION_NOW" >"$WORK/release.json"
upd --from "$WORK/release.json" | grep -q 'is up to date' || fail "update check does not see that this version is the newest"
TARBALL="$(dirname "$BUNDLE")/fbrx-server-$VERSION_NOW.tar.gz"
if [ -f "$TARBALL" ]; then
  upd --file "$TARBALL" --force | grep -q "FBRX Server $VERSION_NOW is ready to install" || fail "update check --file did not get the bundle ready"
  grep -q "^VERSION=$VERSION_NOW\$" "$WORK/update/staged.env" || fail "the staged update is not written down for fbrx-server"
  [ -f "$(sed -n 's/^BUNDLE=//p' "$WORK/update/staged.env")/install.sh" ] || fail "the staged bundle has no install.sh"
fi
echo "OK: fbrx-server update check reads the release list and gets a bundle ready"
