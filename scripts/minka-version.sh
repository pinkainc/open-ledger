#!/usr/bin/env bash
# Has Minka moved since we last synced? Read only: no recording, nothing on the sandbox.
#
#   scripts/minka-version.sh
#
# Compares what we are synced to (SEMVER in server/src/app.ts, the docs mirror in
# ../docs.minka.io) with what Minka serves now (sandbox and production GET /api/v2,
# docs.minka.io/openapi.yaml, npm). Exit 0: nothing new. Exit 10: something moved; what to
# do next is in docs/handoffs/nova-verzija.md.
set -uo pipefail
cd "$(dirname "$0")/.."
MIRROR=${MIRROR:-../docs.minka.io}

semver() { curl -fsS -m 15 "$1/api/v2" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data.semver)}catch{console.log("?")}})'; }
specver() { sed -n 's/^  version: //p' | head -1; }

ours=$(sed -n "s/^export const SEMVER = '\(.*\)'/\1/p" server/src/app.ts)
stg=$(semver https://ldg-stg.one)
prod=$(semver https://ldg.one)
spec_mirror=$( [ -f "$MIRROR/_raw/openapi.yaml" ] && specver < "$MIRROR/_raw/openapi.yaml" || echo '?')
spec_now=$(curl -fsS -m 30 https://docs.minka.io/openapi.yaml 2>/dev/null | specver)
spec_now=${spec_now:-?}

moved=
row() { # name, ours, theirs
  local mark='='
  if [ "$3" = '?' ]; then mark='?'; elif [ "$2" != "$3" ]; then mark='!'; moved=1; fi
  printf '%s %-22s %-10s %s\n' "$mark" "$1" "$2" "$3"
}

printf '  %-22s %-10s %s\n' '' 'mi' 'Minka sada'
row 'sandbox (SEMVER)' "$ours" "$stg"
printf '  %-22s %-10s %s\n' 'produkcija' '' "$prod"
row 'spec (docs mirror)' "$spec_mirror" "$spec_now"
for pkg in @minka/ledger-sdk @minka/cli @minka/bridge-sdk; do
  have=$( [ -f "$MIRROR/_raw/npm/versions.tsv" ] && awk -F'\t' -v p="$pkg" '$1==p{print $2}' "$MIRROR/_raw/npm/versions.tsv")
  now=$(npm view "$pkg" version 2>/dev/null)
  row "npm $pkg" "${have:-?}" "${now:-?}"
done

echo
if [ -n "$moved" ]; then
  echo "Minka se pomaknula (redovi s !). Postupak: docs/handoffs/nova-verzija.md"
  exit 10
fi
echo "Ništa novo. Nema se što snimati."
