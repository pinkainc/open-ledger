// day-boundary
// The daily window of `dailyCount` / `dailyAmount` (TODO L3 `(?)`): a rolling 24 hours
// or a UTC day? frank uses up his `dailyCount` before the boundary and moves once more
// after it: refused under a rolling window, accepted under a UTC day. Also whether a
// `destroy` counts towards `dailyAmount` (gina: 60 destroyed, then 50 moved, limit 100).
//
// The boundary is DAY_BOUNDARY (epoch ms), set by run.sh: the next UTC midnight when
// recording (start the recording a few minutes before it), and a point some seconds
// ahead when checking, which our server is told as its day boundary
// (OPEN_LEDGER_DAY_BOUNDARY_MS), so the check need not wait for midnight.
import { ref, scenario } from './common.js'

const BOUNDARY = Number(process.env.DAY_BOUNDARY)
if (!BOUNDARY) throw new Error('DAY_BOUNDARY is not set (run through conformance/run.sh)')
const { sdk, keyPair, step, create, intent } = await scenario()
const usd = ref('usd'), w = ref
const limit = (name: string, wallet: string, metric: string, amount: number) =>
  intent(name, `i-${name.replace(/\W+/g, '-')}`, [{ action: 'limit', metric, wallet: w(wallet), symbol: usd, amount }])
const send = (name: string, source: string, target: string, amount: number) =>
  intent(name, `i-${name.replace(/\W+/g, '-')}`, [{ action: 'transfer', source: w(source), target: w(target), symbol: usd, amount }])

await step('ledger.update aggregated on', async () => {
  const cur = (await sdk.ledger.read()).response.data as any
  return (sdk as any).ledger.from(cur).data({ config: { ...cur.data.config, 'limits.aggregated.enabled': true } }).hash().sign([{ keyPair }]).send()
})
await create('symbol', { handle: 'usd', factor: 100 })
for (const h of ['frank', 'gina', 'carol']) await create('wallet', { handle: h })
await intent('seed', 'i-seed', [
  { action: 'issue', target: w('frank'), symbol: usd, amount: 1000 },
  { action: 'issue', target: w('gina'), symbol: usd, amount: 1000 },
])

// dailyCount 3: the limit intent counts, so two transfers fill it.
await limit('count frank 3', 'frank', 'dailyCount', 3)
await send('frank 1', 'frank', 'carol', 1)
await send('frank 2', 'frank', 'carol', 1)

await limit('amount gina 100', 'gina', 'dailyAmount', 100)
await intent('destroy gina 60', 'i-destroy-gina-60', [{ action: 'destroy', source: w('gina'), symbol: usd, amount: 60 }])
await send('gina 50', 'gina', 'carol', 50)

const wait = BOUNDARY + 10_000 - Date.now()
if (wait < 0) throw new Error(`the setup ended ${-wait} ms after the day boundary; start earlier`)
console.log(`      waiting ${Math.round(wait / 1000)} s for the day boundary`)
await new Promise((r) => setTimeout(r, wait))

await send('frank 3 after the boundary', 'frank', 'carol', 1)
await step('limits frank', () => sdk.wallet.getLimits('frank'))
await step('balances frank', () => sdk.wallet.getBalances('frank'))
