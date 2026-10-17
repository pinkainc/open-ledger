#!/usr/bin/env bash
# Line coverage of server/src over everything `npm run check` runs: the unit tests and
# our server in every conformance level and the CLI end to end. The report goes to
# .rec/coverage/ (text, json-summary, html).
#
# The code runs from a tsc build with source maps, not through tsx: tsx's maps leave
# class methods that were never called counted as covered (core.ts read 99 % of lines
# with half its functions never called). Only our server and the unit tests write V8
# coverage; scenarios, proxy and bridge are not measured.
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD=.rec/covbuild
V8=.rec/v8cov
rm -rf "$BUILD" "$V8" .rec/coverage
mkdir -p "$V8"
cat > .rec/tsconfig.cov.json <<'EOF'
{ "extends": "../tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "covbuild", "rootDir": "..", "sourceMap": true, "inlineSources": true },
  "include": ["../server/src", "../server/test"] }
EOF
# The tests are not type-checked anywhere (tsconfig leaves them out) and some do not
# pass tsc; it emits regardless, and `npm run check` type-checks server/src.
npx tsc -p .rec/tsconfig.cov.json > .rec/covbuild.log 2>&1 || true
[ -f "$BUILD/server/src/main.js" ] || { cat .rec/covbuild.log; exit 1; }
# crypto.test.ts reads a fixture relative to itself.
mkdir -p "$BUILD/conformance" && ln -s "$PWD/conformance/fixtures" "$BUILD/conformance/fixtures"

# tsx stays as the loader only to resolve @minka/ledger-sdk's directory imports.
export SERVER_CMD="env NODE_V8_COVERAGE=$PWD/$V8 node --import tsx $BUILD/server/src/main.js"
export UNIT_TESTS="env NODE_V8_COVERAGE=$PWD/$V8 node --import tsx --test $BUILD/server/test/*.test.js"
scripts/check.sh

npx c8 report --temp-directory "$V8" --include 'server/src/**' --include "$BUILD/server/src/**" \
  --reporter text --reporter json-summary --reporter html --report-dir .rec/coverage | tee .rec/coverage.txt

# The figures are kept in the repo (conformance/line-coverage.json), and coverage.ts
# renders them into COVERAGE.md, so a plain `npm run check` keeps them.
node -e '
const s = require("./.rec/coverage/coverage-summary.json")
const pct = (x) => ({ lines: x.lines.pct, branches: x.branches.pct, functions: x.functions.pct })
const files = Object.fromEntries(Object.entries(s).filter(([k]) => k !== "total").map(([k, v]) => [k.replace(/^.*\/server\/src\//, ""), pct(v)]).sort())
const out = { measured: new Date().toISOString().slice(0, 10), commit: process.argv[1], total: pct(s.total), files }
require("fs").writeFileSync("conformance/line-coverage.json", JSON.stringify(out, null, 2) + "\n")
' "$(git rev-parse --short HEAD)"
npx tsx conformance/coverage.ts
