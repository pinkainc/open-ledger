// Throughput of concurrent transfers between disjoint wallet pairs (S9 point 3).
//
// Every money-moving step takes a ledger-wide lock (`Store.transaction`). The question
// is how much a per-wallet lock would buy. A ledger is already its own lock, so the same
// transfers spread over L ledgers show the upper bound of that gain without touching
// the server: with per-wallet locks, one ledger could at best do what L ledgers do now.
//
//   npx tsx scripts/bench.ts [transfers=200] [ledgers=1,8]
//
// `daily` mode (S10 point 5): one ledger with `limits.aggregated.enabled` and a
// `dailyCount` limit on every source wallet, transfers sent in rounds. A daily check that
// reads the ledger's whole intent history slows down round after round; one that keeps
// aggregates stays flat.
//
//   npx tsx scripts/bench.ts daily [rounds=10] [perRound=200]
//
// DATABASE_URL picks Postgres (scripts/dev-db.sh fresh bench), otherwise memory.
import { MemoryStore, type Store } from '../server/src/store.js'
import { PgStore } from '../server/src/pg-store.js'
import { newKeyPair, newLedger, ref, sendIntent, setupBooks, startServer } from '../server/test/helpers.js'

const daily = process.argv[2] === 'daily'
const args = daily ? process.argv.slice(3) : process.argv.slice(2)
const transfers = Number(args[0] ?? 200)
const spreads = (args[1] ?? '1,8').split(',').map(Number)
const FINAL = new Set(['completed', 'rejected'])

async function run(ledgers: number) {
  const store: Store & { close?: () => Promise<void> } = process.env.DATABASE_URL ? await PgStore.connect(process.env.DATABASE_URL) : new MemoryStore()
  const server = await startServer(store)
  const kp = await newKeyPair()
  const usd = ref('usd')
  // Disjoint pairs, so no two transfers touch the same wallet in any configuration.
  const perLedger = Math.ceil(transfers / ledgers)
  const books = []
  for (let l = 0; l < ledgers; l++) {
    const { handle, sdk } = await newLedger(server.base, kp)
    const wallets = Array.from({ length: perLedger }, (_, i) => [`a${i}`, `b${i}`]).flat()
    await setupBooks(sdk, kp, wallets)
    const issues = await Promise.all(Array.from({ length: perLedger }, (_, i) => sendIntent(sdk, kp, [{ action: 'issue', target: ref(`a${i}`), symbol: usd, amount: 100 }])))
    await allFinal(store, handle, issues)
    books.push({ handle, sdk })
  }

  const start = performance.now()
  const sent = await Promise.all(
    books.map(async ({ handle, sdk }, l) => {
      const n = Math.min(perLedger, transfers - l * perLedger)
      const handles = await Promise.all(Array.from({ length: n }, (_, i) => sendIntent(sdk, kp, [{ action: 'transfer', source: ref(`a${i}`), target: ref(`b${i}`), symbol: usd, amount: 100 }])))
      return { handle, handles, accepted: performance.now() }
    }),
  )
  const acceptedMs = Math.max(...sent.map((s) => s.accepted)) - start
  const statuses = (await Promise.all(sent.map((s) => allFinal(store, s.handle, s.handles)))).flat()
  const ms = performance.now() - start
  await server.close()
  const completed = statuses.filter((s) => s === 'completed').length
  return { ledgers, transfers: statuses.length, completed, acceptedMs: Math.round(acceptedMs), ms: Math.round(ms), perSecond: Math.round((statuses.length / ms) * 1000) }
}

// Reads the store directly, so waiting adds no HTTP load to what is measured.
async function allFinal(store: Store, ledger: string, handles: string[], timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const statuses = await Promise.all(handles.map(async (h) => (await store.get(ledger, 'intents', h))?.meta.status as string))
    if (statuses.every((s) => FINAL.has(s))) return statuses
    if (Date.now() > end) throw new Error(`${ledger}: ${statuses.filter((s) => !FINAL.has(s)).length} intents unfinished`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function runDaily(rounds: number, perRound: number) {
  const store: Store & { close?: () => Promise<void> } = process.env.DATABASE_URL ? await PgStore.connect(process.env.DATABASE_URL) : new MemoryStore()
  const server = await startServer(store)
  const kp = await newKeyPair()
  const usd = ref('usd')
  const { handle, sdk } = await newLedger(server.base, kp, undefined, { 'limits.aggregated.enabled': true })
  const wallets = Array.from({ length: perRound }, (_, i) => [`a${i}`, `b${i}`]).flat()
  await setupBooks(sdk, kp, wallets)
  const setup = await Promise.all(Array.from({ length: perRound }, (_, i) => sendIntent(sdk, kp, [
    { action: 'issue', target: ref(`a${i}`), symbol: usd, amount: rounds * 100 },
    { action: 'limit', metric: 'dailyCount', wallet: ref(`a${i}`), symbol: usd, amount: rounds * 10 },
  ])))
  await allFinal(store, handle, setup)
  for (let r = 0; r < rounds; r++) {
    const start = performance.now()
    const handles = await Promise.all(Array.from({ length: perRound }, (_, i) => sendIntent(sdk, kp, [{ action: 'transfer', source: ref(`a${i}`), target: ref(`b${i}`), symbol: usd, amount: 100 }])))
    const statuses = await allFinal(store, handle, handles)
    const ms = performance.now() - start
    const completed = statuses.filter((s) => s === 'completed').length
    console.log(JSON.stringify({ round: r + 1, history: perRound * (r + 1), completed, ms: Math.round(ms), perSecond: Math.round((perRound / ms) * 1000) }))
  }
  await server.close()
}

if (daily) {
  console.log(`store: ${process.env.DATABASE_URL ? 'postgres' : 'memory'}, daily limits, ${transfers} rounds of ${args[1] ?? 200} transfers`)
  await runDaily(Number(args[0] ?? 10), Number(args[1] ?? 200))
} else {
  console.log(`store: ${process.env.DATABASE_URL ? 'postgres' : 'memory'}, ${transfers} transfers between disjoint pairs`)
  for (const l of spreads) console.log(JSON.stringify(await run(l)))
}
