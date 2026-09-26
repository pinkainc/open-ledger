#!/usr/bin/env bash
# End-to-end: the official `minka` CLI against our server, through a typical flow.
#
#   server connect → signer → ledger → symbol → wallets → issue → transfer →
#   balances → intent list/show → wallet/symbol/signer reads
#
#   scripts/cli-e2e.sh              start a server (memory, or DATABASE_URL) on :4640
#   BASE=http://…/api/v2 scripts/cli-e2e.sh    use a running server instead
#
# The CLI needs a TTY; tools/minka-seq.exp drives it and answers prompts in order.
# Everything runs under a throwaway HOME, so ~/.minka is never touched. The transcript
# is in .rec/cli-e2e.log; each step is checked, and the balances at the end are read
# over plain HTTP so the check does not depend on the CLI's own output.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p .rec
PORT=${PORT:-4640}
LOG=.rec/cli-e2e.log
: > "$LOG"
: > .rec/cli-e2e.server.log

command -v minka >/dev/null || { echo "minka CLI not installed (npm i -g @minka/cli)" >&2; exit 1; }

pid=
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$HOME_DIR"; }
HOME_DIR=$(mktemp -d)
trap cleanup EXIT

if [ -z "${BASE:-}" ]; then
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then echo "port $PORT is in use" >&2; exit 1; fi
  OPEN_LEDGER_LOG=1 PORT=$PORT npx tsx server/src/main.ts 2>>.rec/cli-e2e.server.log &
  pid=$!
  for _ in $(seq 50); do nc -z 127.0.0.1 "$PORT" 2>/dev/null && break; sleep 0.1; done
  BASE=http://127.0.0.1:$PORT/api/v2
fi

export HOME=$HOME_DIR MINKA_PASS=e2e-$RANDOM-pw
LEDGER=${LEDGER:-e2e-$(date +%s)}
SEQ=tools/minka-seq.exp
fails=0

clean() { tr -d '\r' | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | sed "s/${MINKA_PASS}/<pw>/g"; }

# step <title> <expected regex> <minka-seq steps> -- <minka args…>
step() {
  local title=$1 want=$2 steps=$3; shift 4
  local out
  out=$(timeout 90 "$SEQ" 30 "$steps" -- "$@" 2>&1 | clean)
  { echo "### $title"; echo "\$ minka $*"; echo "$out"; echo; } >> "$LOG"
  if grep -Eq "$want" <<<"$out" && ! grep -Eq 'Reason: |__SEQ_TIMEOUT__' <<<"$out"; then
    echo "  ok    $title"
  else
    echo "  FAIL  $title"; grep -E 'Reason:|__SEQ' -A2 <<<"$out" | head -6 | sed 's/^/        /'
    fails=$((fails + 1))
  fi
}

# balance <wallet> <symbol> → the available amount, read over HTTP
balance() {
  curl -s -H "x-ledger: $LEDGER" "$BASE/wallets/$1/balances" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).data??[];const b=r.find(x=>x.data.symbol===process.argv[1]&&x.data.schema==="available");process.stdout.write(String(b?b.data.amount:"none"))})' "$2"
}

SIGN='Signer:>>@ENTER;password>>@PASS;Sign this>>@YES'
echo "==> minka $(minka --version) against $BASE, ledger $LEDGER"

step "connect to the server" 'Connected to server' '' -- server connect "$BASE"
step "create a signer" 'Handle: e2e' 'Key pair source>>@ENTER;custom data>>@ENTER;password>>@PASS;password>>@PASS' -- -ie signer create e2e
step "create a ledger" 'successfully|created' \
  "Intent expiry>>@ENTER;anchor>>@ENTER;schedule policy>>@ENTER;2FA>>@ENTER;Access strategy>>@ENTER;access content>>@ENTER;custom data>>@ENTER;$SIGN;as an active ledger>>@ENTER;Apply layout>>@ENTER" \
  -- -ie ledger create "$LEDGER"
step "show the ledger" "$LEDGER" '' -- ledger show
step "create a symbol" 'usd' "Handle>>usd;Factor>>@ENTER;custom data>>@ENTER;$SIGN" -- -ie symbol create
for w in alice bob; do
  step "create wallet $w" "$w" "Handle>>$w;Bridge>>@ENTER;custom data>>@ENTER;Add routes>>@ENTER;$SIGN" -- -ie wallet create
done
step "issue 100 usd to alice" 'i-issue' \
  'Handle>>i-issue;Action>>@DOWN1;Target>>alice;Symbol>>usd;Amount>>100;Add another action>>@ENTER;custom data for this intent>>@ENTER;Signers:>>@SELECT;password>>@PASS;Sign this intent>>@YES' \
  -- -ie intent create
sleep 1
step "transfer 25 usd alice → bob" 'i-transfer' \
  'Handle>>i-transfer;Action>>@ENTER;Source>>alice;Target>>bob;Symbol>>usd;Amount>>25;Add another action>>@ENTER;custom data for this intent>>@ENTER;Signers:>>@SELECT;password>>@PASS;Sign this intent>>@YES' \
  -- -ie intent create
sleep 1
step "alice's balances" 'usd' '' -- wallet balances alice
step "list intents" 'i-transfer' '' -- intent list
step "show the transfer" 'completed' '' -- intent show i-transfer
step "show wallet bob" 'bob' '' -- wallet show bob
step "list wallets" 'alice' '' -- wallet list
step "list symbols" 'usd' '' -- symbol list
step "show the symbol" 'usd' '' -- symbol show usd
step "list ledger signers" 'system' '' -- signer list --remote
step "list intents filtered by status" 'i-issue' '' -- intent list --filter '{"meta.status.$in":["completed"],"data.handle":"i-issue"}'
step "list the schemas" 'rest' '' -- schema list

a=$(balance alice usd) b=$(balance bob usd)
if [ "$a/$b" = "7500/2500" ]; then echo "  ok    balances alice 7500, bob 2500 (factor 100)"
else echo "  FAIL  balances alice $a, bob $b (want 7500/2500)"; fails=$((fails + 1)); fi

echo "==> $fails failed (transcript: $LOG)"
[ "$fails" = 0 ]
