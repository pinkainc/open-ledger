#!/usr/bin/env bash
# Conformance runner.
#
#   conformance/run.sh record l0    capture the reference ledger into fixtures/ (creates
#                                   one ledger on the public sandbox; it cannot be deleted)
#   conformance/run.sh check  l0    run the same scenario against our server and compare
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=${1:?record|check}
LEVEL=${2:?level, e.g. l0}
REFERENCE=${REFERENCE:-https://ldg-stg.one}
PROXY_PORT=4610
SERVER_PORT=4620
RUN=${RUN:-$(date -u +%Y%m%d%H%M%S | tr -d '\n')$(printf '%s' $RANDOM | tail -c 3)}
mkdir -p .rec conformance/fixtures

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_port() { for _ in $(seq 50); do nc -z 127.0.0.1 "$1" 2>/dev/null && return; sleep 0.1; done; echo "port $1 never opened" >&2; exit 1; }

if [ "$MODE" = record ]; then
  target=$REFERENCE
  out=conformance/fixtures/$LEVEL.reference.jsonl
else
  PORT=$SERVER_PORT npx tsx server/src/main.ts 2>.rec/server.log &
  pids+=($!)
  wait_port $SERVER_PORT
  target=http://127.0.0.1:$SERVER_PORT
  out=.rec/$LEVEL.candidate.jsonl
fi

rm -f "$out"
TARGET=$target PORT=$PROXY_PORT OUT=$out npx tsx conformance/proxy.ts 2>.rec/proxy.log &
pids+=($!)
wait_port $PROXY_PORT

echo "==> $LEVEL against $target (run $RUN)"
# DIRECT bypasses the proxy, for polling whose count would otherwise depend on timing.
RUN=$RUN BASE=http://127.0.0.1:$PROXY_PORT/api/v2 DIRECT=$target/api/v2 npx tsx conformance/scenarios/$LEVEL.ts

if [ "$MODE" = check ]; then
  echo "==> compare"
  npx tsx conformance/compare.ts conformance/fixtures/$LEVEL.reference.jsonl "$out"
fi
