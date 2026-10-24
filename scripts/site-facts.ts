// Every number the website shows, taken from the repo (landing plan, W2).
//
//   npx tsx scripts/site-facts.ts           write site/src/data/facts.json
//   npx tsx scripts/site-facts.ts --check   fail if facts.json is not what the repo says
//
// The unit-test count is read from `.rec/test.log`, which `scripts/check.sh` writes
// with DATABASE_URL set, so it is the Postgres count. Run `npm run check` first.
//
// The output is deterministic: no date or commit of the run, so `--check` only fails
// when an input changed. `lineCoverage` and `bench` are measurements with their own
// date; they are copied (line-coverage.json) or kept as a constant below, never measured
// here.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'site/src/data/facts.json')

// Levels in README order (README "Status" table). Fixtures are counted, not the README.
export const LEVELS: { id: string; scope: string; fixtures: string[] }[] = [
  { id: 'L0', scope: 'ledger, symbol, wallet: records only, no money moves', fixtures: ['l0'] },
  { id: 'L1', scope: 'intents: issue, transfer, destroy; balances; async processing', fixtures: ['l1'] },
  { id: 'L3', scope: 'limits (minBalance, maxBalance), pagination, reads by luid', fixtures: ['l3'] },
  { id: 'L4 records', scope: 'record lifecycle: update, status proofs, changes, drop, access check; signers, the ledger record, system policies', fixtures: ['records', 'records2'] },
  { id: 'L4 access', scope: 'rule scope, ledger gate, matchers, circles, status policies, token impersonation, claim permissions', fixtures: ['access', 'access2', 'access3', 'access4'] },
  { id: 'L5', scope: '2PC with one bridge: prepare/commit/abort calls, status notifications, retries, restart', fixtures: ['l5'] },
  { id: 'L6', scope: 'several bridges in one intent: two-phase prepare, grouping, aborts only to prepared parts, silent bridges', fixtures: ['l6'] },
  { id: 'Routes', scope: 'addresses schema:handle@parent, wallet routes credit, debit, accept, forward', fixtures: ['routes'] },
  { id: 'L8', scope: 'event deliveries: outbox, attempt proofs, 501 → cancelled, retry, resume', fixtures: ['events'] },
  { id: 'L7', scope: 'threads of forwarded intents; intent expiry (covered by access4)', fixtures: ['l7'] },
  { id: 'L9', scope: 'two ledgers joined by a bridge: cross-ledger payments', fixtures: ['l9', 'l9mixed'] },
]

// Measured by scripts/bench.ts on a local Postgres, 500 transfers between disjoint
// wallet pairs; source docs/2026-10-19-nastanak-benchmark.md. Not re-measured here.
export const BENCH = {
  measured: '2026-10-19',
  source: 'docs/2026-10-19-nastanak-benchmark.md',
  transfers: 500,
  perSecond: { oneLedger: [221, 245], fourLedgers: [271, 295], sixteenLedgers: [398, 446] },
}

export type Divergence = { fixture: string; exchanges: number[] }

/** Non-empty lines: one recorded exchange (or bridge call) per line. */
export function countLines(text: string): number {
  return text.split('\n').filter((l) => l.trim() !== '').length
}

/** `ℹ tests N` from node's test runner output. */
export function testCount(log: string): number {
  const m = /^ℹ tests (\d+)$/m.exec(log)
  if (!m) throw new Error('no "ℹ tests N" line in the test log')
  return Number(m[1])
}

export function parseCoverage(md: string) {
  const spec = /OpenAPI spec \(([\d.]+)\)/.exec(md)
  const head = /\*\*(\d+) of (\d+)\*\* operations implemented; (\d+) of them confirmed/.exec(md)
  if (!spec || !head) throw new Error('COVERAGE.md: header not recognised')
  const resources = [...md.matchAll(/^\| (\w+) \| (\d+)\/(\d+) \|/gm)].map((m) => ({
    name: m[1], implemented: Number(m[2]), total: Number(m[3]),
  }))
  const total = Number(head[2])
  const sum = resources.reduce((s, r) => s + r.total, 0)
  if (sum !== total) throw new Error(`COVERAGE.md: resources add up to ${sum}, header says ${total}`)
  return {
    operations: { total, implemented: Number(head[1]), confirmed: Number(head[3]), spec: spec[1] },
    resources,
  }
}

/** Dated sections `## YYYY-MM-DD — title`; `## ` inside code blocks does not count. */
export function parseFindings(md: string) {
  const dates = [...md.matchAll(/^## (\d{4}-\d{2}-\d{2}) — /gm)].map((m) => m[1]).sort()
  if (!dates.length) throw new Error('FINDINGS.md: no dated sections')
  return { sections: dates.length, firstDate: dates[0], lastDate: dates[dates.length - 1] }
}

export function parseSemver(src: string): string {
  const m = /export const SEMVER = '([^']+)'/.exec(src)
  if (!m) throw new Error('server/src/app.ts: no SEMVER')
  return m[1]
}

/** Exchanges that deliberately differ, per fixture file (`l7` client, `l7.bridge.jsonl` bridge). */
export function differing(divs: Divergence[], fixture: string, bridge: boolean): number {
  const key = bridge ? `${fixture}.bridge.jsonl` : fixture
  return divs.filter((d) => d.fixture === key).reduce((s, d) => s + d.exchanges.length, 0)
}

export function levels(lines: (file: string) => number | null, divs: Divergence[]) {
  return LEVELS.map(({ id, scope, fixtures }) => {
    const rows = fixtures.map((name) => {
      const clientTotal = lines(`${name}.reference.jsonl`)
      if (clientTotal === null) throw new Error(`level ${id}: no fixture ${name}.reference.jsonl`)
      const bridgeTotal = lines(`${name}.bridge.jsonl`) ?? 0
      const clientDiffer = differing(divs, name, false)
      const bridgeDiffer = differing(divs, name, true)
      // `npm run check` replays every fixture and fails on any mismatch that is not a
      // listed divergence, so when it is green, matched = total - listed.
      return {
        name, clientTotal, clientMatched: clientTotal - clientDiffer,
        bridgeTotal, bridgeMatched: bridgeTotal - bridgeDiffer, differ: clientDiffer + bridgeDiffer,
      }
    })
    return { id, scope, fixtures: rows }
  })
}

function collect() {
  const read = (p: string) => readFileSync(join(root, p), 'utf8')
  const fixDir = join(root, 'conformance/fixtures')
  const fixFiles = readdirSync(fixDir)
  const lines = (f: string) => (fixFiles.includes(f) ? countLines(readFileSync(join(fixDir, f), 'utf8')) : null)
  const sumOf = (suffix: string) => fixFiles.filter((f) => f.endsWith(suffix)).reduce((s, f) => s + lines(f)!, 0)

  const log = join(root, '.rec/test.log')
  if (!existsSync(log)) throw new Error('.rec/test.log is missing: run `npm run check` first (it writes the test count)')
  const divs: Divergence[] = JSON.parse(read('conformance/divergences.json'))
  const semver = parseSemver(read('server/src/app.ts'))
  const pkg = JSON.parse(read('package.json'))
  const lc = JSON.parse(read('conformance/line-coverage.json'))
  const client = sumOf('.reference.jsonl')
  const bridge = sumOf('.bridge.jsonl')
  const num = (file: string, re: RegExp) => {
    const m = re.exec(read(file))
    if (!m) throw new Error(`${file}: port not found`)
    return Number(m[1])
  }

  return {
    ...parseCoverage(read('COVERAGE.md')),
    version: { server: semver, sandbox: semver },
    fixtures: {
      reference: fixFiles.filter((f) => f.endsWith('.reference.jsonl')).length,
      bridge: fixFiles.filter((f) => f.endsWith('.bridge.jsonl')).length,
    },
    exchanges: { client, bridge, total: client + bridge },
    // common.ts is shared code, not a scenario.
    scenarios: { count: readdirSync(join(root, 'conformance/scenarios')).filter((f) => f.endsWith('.ts') && f !== 'common.ts').length },
    tests: {
      postgres: testCount(readFileSync(log, 'utf8')),
      files: readdirSync(join(root, 'server/test')).filter((f) => f.endsWith('.test.ts')).length,
    },
    server: { sourceFiles: readdirSync(join(root, 'server/src')).filter((f) => f.endsWith('.ts')).length },
    divergences: {
      count: divs.length,
      fixtures: new Set(divs.map((d) => d.fixture.replace(/\.bridge\.jsonl$/, ''))).size,
    },
    findings: parseFindings(read('FINDINGS.md')),
    levels: levels(lines, divs),
    interop: {
      supply: 325,
      mixed: { client: lines('l9mixed.reference.jsonl'), bridge: lines('l9mixed.bridge.jsonl') },
    },
    lineCoverage: { ...lc.total, measured: lc.measured, commit: lc.commit },
    // One line per event (backfill, record, …); several can name the same ledger.
    footprint: (() => {
      const events = read('conformance/footprint.jsonl').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      return { ledgers: new Set(events.map((e) => e.ledger)).size, events: events.length }
    })(),
    ports: {
      server: num('server/src/main.ts', /PORT \?\? (\d+)/),
      cliE2e: num('scripts/cli-e2e.sh', /PORT=\$\{PORT:-(\d+)\}/),
      devPostgres: num('scripts/dev-db.sh', /PGPORT_DEV:-(\d+)/),
    },
    node: { engine: pkg.engines.node },
    license: pkg.license,
    bench: BENCH,
  }
}

/** Numbers the README states in prose; they must agree with the facts. */
export function readmeMismatches(readme: string, f: ReturnType<typeof collect>): string[] {
  const bad: string[] = []
  const tests = /\((?:`server\/test\/`, )?(\d+) with Postgres\)/.exec(readme)
  if (!tests || Number(tests[1]) !== f.tests.postgres) bad.push(`README: unit tests "${tests?.[1]} with Postgres", facts say ${f.tests.postgres}`)
  const div = /So far: (\d+) cases in (\d+) fixtures/.exec(readme)
  if (!div || Number(div[1]) !== f.divergences.count || Number(div[2]) !== f.divergences.fixtures)
    bad.push(`README: divergences "${div?.[0]}", facts say ${f.divergences.count} in ${f.divergences.fixtures} fixtures`)
  return bad
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const facts = collect()
  const json = JSON.stringify(facts, null, 2) + '\n'
  const bad = readmeMismatches(readFileSync(join(root, 'README.md'), 'utf8'), facts)
  if (process.argv.includes('--check')) {
    const now = existsSync(out) ? readFileSync(out, 'utf8') : ''
    if (now !== json) bad.unshift('site/src/data/facts.json is stale: run `npx tsx scripts/site-facts.ts`')
    if (bad.length) { console.error(bad.join('\n')); process.exit(1) }
    console.log(`facts.json up to date (${facts.operations.implemented}/${facts.operations.total} operations, ${facts.tests.postgres} tests, ${facts.exchanges.total} exchanges)`)
  } else {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, json)
    console.log(`wrote ${out}`)
    if (bad.length) console.error(bad.join('\n'))
  }
}
