// Follow-up to `limits2`. There, `dailyAmount: 500` on bob never fired although bob
// moved 602, and `dailyCount` counted as if only intents after the config was enabled
// (or after the limit was set) counted, the limit intent itself included.
//
// Here the config is on from the start: does a transfer made before the limit count,
// does the limit intent count, and does `dailyAmount` fire at all (1 against 300,
// whatever the unit)? Bounded: eleven intents.
import { ref, scenario } from './common.js'

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
  { action: 'issue', target: w('frank'), symbol: usd, amount: 10000 },
  { action: 'issue', target: w('gina'), symbol: usd, amount: 10000 },
])
await send('frank before limit', 'frank', 'carol', 10)
await limit('count frank 4', 'frank', 'dailyCount', 4)
await send('frank 1', 'frank', 'carol', 10)
await send('frank 2', 'frank', 'carol', 10)
await send('frank 3', 'frank', 'carol', 10)

await limit('amount gina 1', 'gina', 'dailyAmount', 1)
await send('gina 300', 'gina', 'carol', 300)
await send('gina 9000', 'gina', 'carol', 9000)
await step('limits gina', () => sdk.wallet.getLimits('gina'))
await step('balances gina', () => sdk.wallet.getBalances('gina'))
