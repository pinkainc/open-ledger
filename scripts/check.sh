#!/usr/bin/env bash
# Everything that must be green before a commit: type check, unit tests and the
# conformance check of every level, each against memory and Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL=$(./scripts/dev-db.sh start)
echo "==> typecheck" && npx tsc -p .
echo "==> unit tests (memory + postgres)"
npm test > .rec/test.log 2>&1 && ok=1 || ok=0
grep -E "^ℹ (tests|pass|fail)" .rec/test.log
[ $ok = 1 ] || { grep -E "✖" .rec/test.log; exit 1; }

for level in $(ls conformance/fixtures | sed -n 's/\.reference\.jsonl$//p'); do
  for store in memory postgres; do
    if [ $store = memory ]; then url=; else url=$DATABASE_URL; fi
    printf '==> conformance %-3s %-9s ' "$level" "$store"
    DATABASE_URL=$url ./conformance/run.sh check "$level" > .rec/conf.log 2>&1 && ok=1 || ok=0
    tail -1 .rec/conf.log
    [ $ok = 1 ] || { grep -E "FAIL|^ " .rec/conf.log | head -40; exit 1; }
  done
done
