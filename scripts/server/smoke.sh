#!/usr/bin/env bash
# Smoke test of a built FBRX Server bundle without installing it: starts the FBRX core in server mode (the ai role)
# and FBRX Virtual (simulated hypervisor) next to each other, as on a server, and checks that the console reaches the
# core with the console token. Then FBRX Virtual as a gate (simulated), driven by the bundled fbrx-gate command line.
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
GATE_ENV=(FBRX_V_ROLES=gate FBRX_V_GATE=simulated FBRX_V_GATE_WAN=eno1 FBRX_V_GATE_LAN=eno2 FBRX_V_GATE_FIRST=commit FBRX_V_TLS=off FBRX_V_HOST=127.0.0.1 FBRX_V_PORT="$G_PORT" FBRX_V_DATA_DIR="$WORK/gate" FBRX_V_LOG_LEVEL=warn FBRX_V_CONSOLE_DIR="$BUNDLE/fbrx-virtual/virtual-console")
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
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $(cat "$WORK/gate/cli.token")" "http://127.0.0.1:$G_PORT/v1/gate")" = "200" ] || fail "the command line's token is not accepted from this computer"
echo "OK: FBRX Gate commits, confirms and previews from the bundled command line"

