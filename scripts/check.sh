#!/usr/bin/env bash
# Everything that must be green before a commit: type check, unit tests and the
# conformance check of every level, each against memory and Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."

# Unit tests get an empty database per run: they never clean up, and the expiry
# test scans every ledger (3735 after a few weeks of runs pushed it past 5 s).
export DATABASE_URL=$(./scripts/dev-db.sh fresh open_ledger_test)
echo "==> typecheck" && npx tsc -p .
echo "==> unit tests (memory + postgres)"
npm test > .rec/test.log 2>&1 && ok=1 || ok=0
grep -E "^ℹ (tests|pass|fail)" .rec/test.log
[ $ok = 1 ] || { grep -E "✖" .rec/test.log; exit 1; }

for level in $(ls conformance/fixtures | sed -n 's/\.reference\.jsonl$//p'); do
  # Recorded behaviour we do not implement yet is listed with the reason, not hidden.
  why=$(node -e 'const p=require("./conformance/pending.json"); process.stdout.write(p[process.argv[1]] ?? "")' "$level")
  if [ -n "$why" ]; then printf '==> conformance %-9s pending: %s\n' "$level" "$why"; continue; fi
  # The `cli` level drives the official CLI, like the end-to-end run below.
  if [ "$level" = cli ] && ! command -v minka >/dev/null; then printf '==> conformance %-9s skipped: minka CLI not installed\n' "$level"; continue; fi
  for store in memory postgres; do
    # Postgres: an empty database per run, so no earlier run's intent is resumed.
    if [ $store = memory ]; then url=; else url=$(./scripts/dev-db.sh fresh open_ledger_conf); fi
    printf '==> conformance %-9s %-9s ' "$level" "$store"
    DATABASE_URL=$url ./conformance/run.sh check "$level" > .rec/conf.log 2>&1 && ok=1 || ok=0
    grep -E "exchanges match" .rec/conf.log | paste -sd '|' - | sed 's/|/ · bridge calls: /'
    [ $ok = 1 ] || { grep -E "FAIL|^ " .rec/conf.log | head -40; exit 1; }
  done
done

# The official CLI through a whole flow, on Postgres (skipped when it is not installed).
if command -v minka >/dev/null; then
  printf '==> minka CLI end to end (postgres) '
  DATABASE_URL=$(./scripts/dev-db.sh fresh open_ledger_cli) scripts/cli-e2e.sh > .rec/cli.log 2>&1 && ok=1 || ok=0
  tail -1 .rec/cli.log
  [ $ok = 1 ] || { grep -E "FAIL" -A3 .rec/cli.log; exit 1; }
fi

echo "==> coverage" && npx tsx conformance/coverage.ts
echo "==> sandbox footprint" && npx tsx conformance/footprint.ts verify
