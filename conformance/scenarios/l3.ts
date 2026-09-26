// L3 scenario: limits, plus the questions L1 left open (list order, mixed and
// multi-symbol intents, whether credits in an intent offset its debits, unknown source,
// which resolution error wins, pagination, reading an intent by luid).
import { ref, scenario } from './common.js'

const { sdk, step, create, intent } = await scenario()
const usd = ref('usd'), eur = ref('eur'), w = ref

await create('symbol', { handle: 'usd', factor: 100 })
await create('symbol', { handle: 'eur', factor: 100 })
for (const h of ['alice', 'bob', 'carol']) await create('wallet', { handle: h })

await step('symbol.list', () => sdk.symbol.list())
await step('wallet.list', () => sdk.wallet.list())
await step('wallet.list page 1 of 2', () => sdk.wallet.list({ page: { index: 1, limit: 2 } } as any))

// Docs: "if there's another claim in the same intent that brings it back within normal
// range, the intent will not break the limit". L1 suggests credits are not counted.
await intent('credit covers debit', 'i-cover', [
  { action: 'issue', target: w('alice'), symbol: usd, amount: 100 },
  { action: 'transfer', source: w('alice'), target: w('bob'), symbol: usd, amount: 100 },
])
await intent('swap from zero', 'i-swap', [
  { action: 'transfer', source: w('carol'), target: w('bob'), symbol: usd, amount: 50 },
  { action: 'transfer', source: w('bob'), target: w('carol'), symbol: usd, amount: 50 },
])
await intent('mixed issue and transfer', 'i-mixed', [
  { action: 'issue', target: w('alice'), symbol: usd, amount: 1000 },
  { action: 'transfer', source: w('bob'), target: w('alice'), symbol: usd, amount: 1 },
])
await intent('issue only', 'i-seed', [{ action: 'issue', target: w('alice'), symbol: usd, amount: 5000 }])
await intent('multi-symbol', 'i-multi', [
  { action: 'issue', target: w('alice'), symbol: eur, amount: 300 },
  { action: 'transfer', source: w('alice'), target: w('bob'), symbol: usd, amount: 10 },
])
await step('balances alice', () => sdk.wallet.getBalances('alice'))
await intent('unknown source', 'i-ghost-src', [{ action: 'transfer', source: w('ghost'), target: w('alice'), symbol: usd, amount: 1 }])
await intent('unknown symbol and wallet', 'i-ghost-both', [{ action: 'transfer', source: w('ghost'), target: w('alice'), symbol: ref('gbp'), amount: 1 }])

// Limits.
await intent('limit minBalance', 'i-limit-min', [{ action: 'limit', metric: 'minBalance', wallet: w('carol'), symbol: usd, amount: -20000 }])
await step('limits carol', () => sdk.wallet.getLimits('carol'))
await intent('overdraft within limit', 'i-od-ok', [{ action: 'transfer', source: w('carol'), target: w('bob'), symbol: usd, amount: 15000 }])
await intent('overdraft beyond limit', 'i-od-no', [{ action: 'transfer', source: w('carol'), target: w('bob'), symbol: usd, amount: 6000 }])
await step('balances carol', () => sdk.wallet.getBalances('carol'))
await intent('limit maxBalance', 'i-limit-max', [{ action: 'limit', metric: 'maxBalance', wallet: w('bob'), symbol: usd, amount: 20000 }])
await intent('credit beyond max', 'i-max-no', [{ action: 'issue', target: w('bob'), symbol: usd, amount: 10000 }])
await step('limits bob', () => sdk.wallet.getLimits('bob'))
await step('balances bob', () => sdk.wallet.getBalances('bob'))

const seeded: any = await sdk.intent.read('i-seed')
await step('intent.read by luid', () => sdk.intent.read(seeded.luid))
await step('intent.list page 0 of 3', () => sdk.intent.list({ page: { index: 0, limit: 3 } } as any))
