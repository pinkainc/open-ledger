#!/usr/bin/env bash
# Conformance runner.
#
#   conformance/run.sh record l0    capture the reference ledger into fixtures/ (creates
#                                   one ledger on the public sandbox; it cannot be deleted,
#                                   so the run is logged in conformance/footprint.jsonl)
#   conformance/run.sh check  l0    run the same scenario against our server and compare
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=${1:?record|check}
LEVEL=${2:?level, e.g. l0}
REFERENCE=${REFERENCE:-https://ldg-stg.one}
PROXY_PORT=4610
SERVER_PORT=4620
BRIDGE_PORT=4630
RUN=${RUN:-$(date -u +%Y%m%d%H%M%S | tr -d '\n')$(printf '%s' $RANDOM | tail -c 3)}
mkdir -p .rec conformance/fixtures

pids=()
started=
# Waits for the ports to close, so the next run does not take them for another run's.
# A recording that began is logged as ended, kept or not, failed or not (footprint.ts).
cleanup() {
  rc=$?
  if [ -n "$started" ]; then
    npx tsx conformance/footprint.ts end "$RUN" "$LEVEL" "$rc" "$out" ${bridge_out:-} || echo "footprint: end not logged for $RUN" >&2
  fi
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  for _ in $(seq 50); do
    nc -z 127.0.0.1 $PROXY_PORT 2>/dev/null || nc -z 127.0.0.1 $SERVER_PORT 2>/dev/null || nc -z 127.0.0.1 $BRIDGE_PORT 2>/dev/null || return 0
    sleep 0.1
  done
}
trap cleanup EXIT

# Record and check share these ports; a second run would record through the first
# one's proxy and mix two scenarios into one fixture (it happened to access4).
for port in $PROXY_PORT $SERVER_PORT $BRIDGE_PORT; do
  if nc -z 127.0.0.1 $port 2>/dev/null; then echo "port $port is in use: another conformance run?" >&2; exit 1; fi
done

wait_port() { for _ in $(seq 50); do nc -z 127.0.0.1 "$1" 2>/dev/null && return; sleep 0.1; done; echo "port $1 never opened" >&2; exit 1; }

if [ "$MODE" = record ]; then
  target=$REFERENCE
  out=conformance/fixtures/$LEVEL.reference.jsonl
else
  # A recorded one-minute expiry takes a second here; see OPEN_LEDGER_MINUTE_MS in main.ts.
  # PUBLIC_URL: the server answers for the reference's address, so a token's `hsh`
  # (computed over that address by the scenario, HSH_URL) holds for both.
  # OPEN_LEDGER_REPORTS_BUCKET: the sandbox's reporting bucket, which report assets must name.
  PORT=$SERVER_PORT PUBLIC_URL=$REFERENCE/api/v2 OPEN_LEDGER_REPORTS_BUCKET=ledger-reports-stg OPEN_LEDGER_MINUTE_MS=${OPEN_LEDGER_MINUTE_MS:-1000} npx tsx server/src/main.ts 2>.rec/server.log &
  pids+=($!)
  wait_port $SERVER_PORT
  target=http://127.0.0.1:$SERVER_PORT
  out=.rec/$LEVEL.candidate.jsonl
fi

# A scenario that says `needs-local-server` also drives our server (LOCAL) while recording,
# e.g. to join it to the reference (l9mixed); checking, our server is the target anyway.
LOCAL=http://127.0.0.1:$SERVER_PORT/api/v2
if [ "$MODE" = record ] && grep -q needs-local-server conformance/scenarios/$LEVEL.ts; then
  PORT=$SERVER_PORT npx tsx server/src/main.ts 2>.rec/server.log &
  pids+=($!)
  wait_port $SERVER_PORT
fi
export LOCAL

rm -f "$out"
TARGET=$target PORT=$PROXY_PORT OUT=$out npx tsx conformance/proxy.ts 2>.rec/proxy.log &
pids+=($!)
wait_port $PROXY_PORT

# A scenario that says `needs-bridge` runs a bridge (conformance/bridge.ts) on
# BRIDGE_PORT. Our server reaches it directly; the sandbox through a public quick
# tunnel, which exposes nothing but that bridge for the length of the run.
BRIDGE_URL=http://127.0.0.1:$BRIDGE_PORT/v2
if grep -q needs-bridge conformance/scenarios/$LEVEL.ts; then
  if [ "$MODE" = record ]; then
    bridge_out=conformance/fixtures/$LEVEL.bridge.jsonl
    cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$BRIDGE_PORT 2>.rec/tunnel.log &
    pids+=($!)
    for _ in $(seq 60); do url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' .rec/tunnel.log | head -1 || true); [ -n "$url" ] && break; sleep 0.5; done
    [ -n "$url" ] || { echo "tunnel did not come up" >&2; exit 1; }
    # The edge answers 502 until the bridge listens, which proves the tunnel is routed.
    for _ in $(seq 60); do code=$(curl -s -o /dev/null -w '%{http_code}' "$url/" || true); [ "$code" != 000 ] && [ "$code" != 530 ] && break; sleep 1; done
    BRIDGE_URL=$url/v2
  else
    bridge_out=.rec/$LEVEL.bridge.candidate.jsonl
  fi
  rm -f "$bridge_out"
  export BRIDGE_OUT=$bridge_out BRIDGE_PORT
fi
export BRIDGE_URL

if [ "$MODE" = record ]; then
  # Ledgers on the sandbox are created by one operator key kept outside the repo, and
  # every recording is logged before its first request (conformance/footprint.jsonl).
  export OPEN_LEDGER_OPERATOR_KEY=${OPEN_LEDGER_OPERATOR_KEY:-${XDG_CONFIG_HOME:-$HOME/.config}/open-ledger/sandbox-operator.json}
  npx tsx conformance/footprint.ts start "$RUN" "$LEVEL" "$REFERENCE"
  started=1
fi

echo "==> $LEVEL against $target (run $RUN)"
# DIRECT bypasses the proxy, for polling whose count would otherwise depend on timing.
RUN=$RUN HSH_URL=$REFERENCE/api/v2 BASE=http://127.0.0.1:$PROXY_PORT/api/v2 DIRECT=$target/api/v2 npx tsx conformance/scenarios/$LEVEL.ts

if [ "$MODE" = record ]; then
  npx tsx conformance/own-ledger.ts "$out" "$RUN"
fi

if [ "$MODE" = check ]; then
  echo "==> compare"
  npx tsx conformance/compare.ts conformance/fixtures/$LEVEL.reference.jsonl "$out"
  if [ -f conformance/fixtures/$LEVEL.bridge.jsonl ]; then
    echo "==> compare bridge calls"
    npx tsx conformance/compare.ts conformance/fixtures/$LEVEL.bridge.jsonl .rec/$LEVEL.bridge.candidate.jsonl
  fi
fi
