// Last follow-up on aggregated limits. Single-claim intents cannot tell "the limit
// intent counts and the bound is inclusive" from "it does not count and the bound is
// exclusive"; a two-claim intent can. Also: is `dailyAmount` inclusive, and does an
// issue count towards either metric? Bounded: nine intents.
//   w1  count 3, then one intent with two transfers out, then one transfer out
//   w2  amount 100, then exactly 100 out, then an issue of 50
//   w3  count 2, then an issue, then one transfer out
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, intent } = await scenario()
const usd = ref('usd'), w = ref
const limit = (wallet: string, metric: string, amount: number) =>
  intent(`${metric} ${wallet} ${amount}`, `i-limit-${wallet}`, [{ action: 'limit', metric, wallet: w(wallet), symbol: usd, amount }])
const send = (name: string, source: string, target: string, amount: number) =>
  intent(name, `i-${name.replace(/\W+/g, '-')}`, [{ action: 'transfer', source: w(source), target: w(target), symbol: usd, amount }])

await step('ledger.update aggregated on', async () => {
  const cur = (await sdk.ledger.read()).response.data as any
  return (sdk as any).ledger.from(cur).data({ config: { ...cur.data.config, 'limits.aggregated.enabled': true } }).hash().sign([{ keyPair }]).send()
})
await create('symbol', { handle: 'usd', factor: 100 })
for (const h of ['w1', 'w2', 'w3', 'carol']) await create('wallet', { handle: h })
await intent('seed', 'i-seed', ['w1', 'w2', 'w3'].map((h) => ({ action: 'issue', target: w(h), symbol: usd, amount: 10000 })))

await limit('w1', 'dailyCount', 3)
await intent('w1 two claims', 'i-w1-two', [
  { action: 'transfer', source: w('w1'), target: w('carol'), symbol: usd, amount: 1 },
  { action: 'transfer', source: w('w1'), target: w('carol'), symbol: usd, amount: 1 },
])
await send('w1 one more', 'w1', 'carol', 1)

await limit('w2', 'dailyAmount', 100)
await send('w2 exactly 100', 'w2', 'carol', 100)
await intent('w2 issue 50', 'i-w2-issue', [{ action: 'issue', target: w('w2'), symbol: usd, amount: 50 }])

await limit('w3', 'dailyCount', 2)
await intent('w3 issue', 'i-w3-issue', [{ action: 'issue', target: w('w3'), symbol: usd, amount: 50 }])
await send('w3 one out', 'w3', 'carol', 1)
