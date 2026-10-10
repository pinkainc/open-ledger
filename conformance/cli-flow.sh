#!/usr/bin/env bash
# The official `minka` CLI through one flow, for the `cli` conformance level
# (conformance/scenarios/cli.ts runs it): the same commands against the sandbox when
# recording and against our server when checking, through the recording proxy.
#
#   BASE        the ledger API (the proxy), e.g. http://127.0.0.1:4610/api/v2
#   LEDGER      the ledger to create
#   SIGNER_PEM  the operator key as a PKCS#8 PEM, imported as the CLI's signer
#   BRIDGE_URL  a bridge that answers every call 501 (conformance/bridge.ts)
#
# The CLI needs a TTY; tools/minka-seq.exp drives it. HOME is a throwaway directory.
set -uo pipefail
cd "$(dirname "$0")/.."
SEQ=tools/minka-seq.exp
fails=0
clean() { tr -d '\r' | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g'; }

# step <title> <expected regex> <minka-seq steps> -- <minka args…>
step() {
  local title=$1 want=$2 steps=$3; shift 4
  out=$(timeout 90 "$SEQ" 30 "$steps" -- "$@" 2>&1 | clean)
  { echo "### $title"; echo "\$ minka $*"; echo "$out"; echo; } >> "${CLI_LOG:-/dev/null}"
  if grep -Eq "$want" <<<"$out" && ! grep -Eq '__SEQ_TIMEOUT__' <<<"$out"; then echo "ok    cli $title"
  else echo "error cli $title"; grep -E 'Reason:|__SEQ' -A2 <<<"$out" | head -4 | sed 's/^/      /'; fails=$((fails + 1)); fi
}

SIGN='Signer:>>@ENTER;password>>@PASS;Sign this>>@YES'
step "server connect" 'Connected to server' '' -- server connect "$BASE"
step "signer import" 'Public:' 'custom data>>@ENTER;password>>@PASS;password>>@PASS' -- -ie signer create operator -i "$SIGNER_PEM"
step "ledger create" 'successfully|created' \
  "Intent expiry>>@ENTER;anchor>>@ENTER;schedule policy>>@ENTER;2FA>>@ENTER;Access strategy>>@ENTER;access content>>@ENTER;custom data>>@ENTER;$SIGN;as an active ledger>>@ENTER;Apply layout>>@ENTER" \
  -- -ie ledger create "$LEDGER"
step "ledger show" "$LEDGER" '' -- ledger show
step "symbol create usd" 'usd' "Handle>>usd;Factor>>@ENTER;custom data>>@ENTER;$SIGN" -- -ie symbol create
for w in alice bob; do
  step "wallet create $w" "$w" "Handle>>$w;Bridge>>@ENTER;custom data>>@ENTER;Add routes>>@ENTER;$SIGN" -- -ie wallet create
done
step "intent create issue" 'i-issue' \
  'Handle>>i-issue;Action>>@DOWN1;Target>>alice;Symbol>>usd;Amount>>100;Add another action>>@ENTER;custom data for this intent>>@ENTER;Signers:>>@SELECT;password>>@PASS;Sign this intent>>@YES' \
  -- -ie intent create
sleep 2
step "intent create transfer" 'i-transfer' \
  'Handle>>i-transfer;Action>>@ENTER;Source>>alice;Target>>bob;Symbol>>usd;Amount>>25;Add another action>>@ENTER;custom data for this intent>>@ENTER;Signers:>>@SELECT;password>>@PASS;Sign this intent>>@YES' \
  -- -ie intent create
sleep 2
step "wallet balances alice" 'usd' '' -- wallet balances alice
step "intent show i-transfer" 'completed' '' -- intent show i-transfer
step "wallet show bob" 'bob' '' -- wallet show bob
step "symbol show usd" 'usd' '' -- symbol show usd
step "intent list filtered" 'i-issue' '' -- intent list --filter '{"meta.status.$in":["completed"],"data.handle":"i-issue"}'

# A bridge that answers 501: each delivery is cancelled after one attempt.
step "bridge create bank1" 'bank1' \
  "Handle>>bank1;Schema>>@ENTER;Server>>$BRIDGE_URL;Debit claim grouping>>@ENTER;Credit claim grouping>>@ENTER;bridge traits>>@YES;Traits>>@CHECK2;Define filters>>@ENTER;security rules>>@ENTER;custom data>>@ENTER;Signer:>>@ENTER;password>>@PASS" \
  -- -ie bridge create
step "bridge show bank1" 'bank1' '' -- bridge show bank1
step "wallet create ext (bridge bank1)" 'ext' "Handle>>ext;Bridge>>bank1;custom data>>@ENTER;Add routes>>@ENTER;$SIGN" -- -ie wallet create
step "intent create transfer to ext" 'i-ext' \
  'Handle>>i-ext;Action>>@ENTER;Source>>alice;Target>>ext;Symbol>>usd;Amount>>5;Add another action>>@ENTER;custom data for this intent>>@ENTER;Signers:>>@SELECT;password>>@PASS;Sign this intent>>@YES' \
  -- -ie intent create
sleep 4
step "intent show i-ext" 'i-ext' '' -- intent show i-ext
step "bridge events list" 'cancelled' '' -- bridge events list bank1
# The list is a table whose first column wraps the 17-character handle; with one
# delivery, its handle is the first column of every row between the rules.
delivery=$(timeout 60 "$SEQ" 30 '' -- bridge events list bank1 2>/dev/null | clean |
  awk '/^╟/{on=1; next} /^╚/{on=0} on && /^║/{split($0, c, "│"); gsub(/[║ ]/, "", c[1]); printf "%s", c[1]}')
step "bridge events show" 'cancelled' '' -- bridge events show bank1 "${delivery:-none}"
step "bridge events retry" "$delivery" "Signer:>>@ENTER;password>>@PASS;Event handle to retry>>${delivery:-none};Confirm to retry>>@YES" -- -ie bridge events retry bank1
sleep 4
step "bridge events list after retry" 'cancelled' '' -- bridge events list bank1

echo "      $fails CLI steps failed"
