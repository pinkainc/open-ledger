// Aggregated limits (docs: moving-money/wallet-limits): `dailyCount` and
// `dailyAmount`, which need the ledger config `limits.aggregated.enabled`.
//
// Questions: what a daily limit does while the config is off; whether a transfer made
// before the limit was set counts; whether credits count (docs: dailyAmount "includes
// both receiving and sending"); whether a rejected intent counts; whether the bound
// is inclusive; whether two claims in one intent count once or twice; and what a
// limit on a wallet with no balance row does to its balances.
//
// Bounded: a fixed list of intents, no loops on the sandbox.
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, intent } = await scenario()
const usd = ref('usd'), w = ref
const current = async () => (await sdk.ledger.read()).response.data as any
const limit = (name: string, wallet: string, metric: string, amount: number) =>
  intent(name, `i-${name.replace(/\W+/g, '-')}`, [{ action: 'limit', metric, wallet: w(wallet), symbol: usd, amount }])
const send = (name: string, source: string, target: string, amount: number) =>
  intent(name, `i-${name.replace(/\W+/g, '-')}`, [{ action: 'transfer', source: w(source), target: w(target), symbol: usd, amount }])

await create('symbol', { handle: 'usd', factor: 100 })
for (const h of ['alice', 'bob', 'carol', 'dave', 'erin']) await create('wallet', { handle: h })
await intent('seed', 'i-seed', [
  { action: 'issue', target: w('alice'), symbol: usd, amount: 10000 },
  { action: 'issue', target: w('erin'), symbol: usd, amount: 10000 },
])
await send('alice before limits', 'alice', 'carol', 100)

// Config off.
await limit('count erin while off', 'erin', 'dailyCount', 1)
await send('erin 1 while off', 'erin', 'carol', 10)
await send('erin 2 while off', 'erin', 'carol', 10)
await step('limits erin', () => sdk.wallet.getLimits('erin'))

await step('ledger.update aggregated on', async () => {
  const cur = await current()
  return (sdk as any).ledger.from(cur).data({ config: { ...cur.data.config, 'limits.aggregated.enabled': true } }).hash().sign([{ keyPair }]).send()
})
await step('ledger.read', () => sdk.ledger.read())
await send('erin 3 after on', 'erin', 'carol', 10)

// dailyCount on alice: one issue and one transfer happened before the limit.
await limit('count alice 3', 'alice', 'dailyCount', 3)
await step('limits alice', () => sdk.wallet.getLimits('alice'))
await send('alice 1', 'alice', 'carol', 100)
await send('alice 2', 'alice', 'carol', 100)
await send('alice 3', 'alice', 'carol', 100)
await send('alice 4', 'alice', 'carol', 100)
await limit('count alice 6', 'alice', 'dailyCount', 6)
await send('alice 5 after raise', 'alice', 'carol', 100)
await intent('alice two claims', 'i-alice-two', [
  { action: 'transfer', source: w('alice'), target: w('carol'), symbol: usd, amount: 1 },
  { action: 'transfer', source: w('alice'), target: w('bob'), symbol: usd, amount: 1 },
])
await send('alice after two claims', 'alice', 'carol', 1)
await send('carol to alice (credit)', 'carol', 'alice', 1)
await step('balances alice', () => sdk.wallet.getBalances('alice'))

// dailyAmount on bob, set before bob has a balance.
await limit('amount bob 500', 'bob', 'dailyAmount', 500)
await step('balances bob before credit', () => sdk.wallet.getBalances('bob'))
await intent('issue bob 300', 'i-issue-bob', [{ action: 'issue', target: w('bob'), symbol: usd, amount: 300 }])
await send('bob 150', 'bob', 'carol', 150)
await send('bob 100 over', 'bob', 'carol', 100)
await send('bob 50 to the bound', 'bob', 'carol', 50)
await send('bob 1 past the bound', 'bob', 'carol', 1)
await send('carol to bob 1 (credit past the bound)', 'carol', 'bob', 1)
await step('limits bob', () => sdk.wallet.getLimits('bob'))
await step('balances bob', () => sdk.wallet.getBalances('bob'))

// A limit on a wallet that never held anything.
await step('balances dave before', () => sdk.wallet.getBalances('dave'))
await limit('min dave', 'dave', 'minBalance', -1000)
await step('balances dave after', () => sdk.wallet.getBalances('dave'))
await step('limits dave', () => sdk.wallet.getLimits('dave'))
