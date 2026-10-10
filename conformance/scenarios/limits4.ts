// Follow-up to `limits2`/`limits3`: is `dailyAmount` in minor units counting debits
// only (bob moved 301 out and 302 in under 500), or the limit times the symbol's
// factor counting both ways? hank: limit 400, then 350 and 100 out (450 > 400 only in
// minor units), then 100 in. Bounded: five intents.
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, intent } = await scenario()
const usd = ref('usd'), w = ref
const send = (name: string, source: string, target: string, amount: number) =>
  intent(name, `i-${name.replace(/\W+/g, '-')}`, [{ action: 'transfer', source: w(source), target: w(target), symbol: usd, amount }])

await step('ledger.update aggregated on', async () => {
  const cur = (await sdk.ledger.read()).response.data as any
  return (sdk as any).ledger.from(cur).data({ config: { ...cur.data.config, 'limits.aggregated.enabled': true } }).hash().sign([{ keyPair }]).send()
})
await create('symbol', { handle: 'usd', factor: 100 })
for (const h of ['hank', 'carol']) await create('wallet', { handle: h })
await intent('seed', 'i-seed', [
  { action: 'issue', target: w('hank'), symbol: usd, amount: 10000 },
  { action: 'issue', target: w('carol'), symbol: usd, amount: 10000 },
])
await intent('amount hank 400', 'i-amount-hank', [{ action: 'limit', metric: 'dailyAmount', wallet: w('hank'), symbol: usd, amount: 400 }])
await send('hank 350 out', 'hank', 'carol', 350)
await send('hank 100 out', 'hank', 'carol', 100)
await send('hank 100 in', 'carol', 'hank', 100)
await step('balances hank', () => sdk.wallet.getBalances('hank'))
