// User schemas (about-schemas): "if there is at least one schema created for any record
// type, then the `schema` property is required for all subsequent records being
// updated or created under said type", and "the `<record>.data` property is validated
// against the specified schema" — while the docs' own example validates `{data: …}`.
// Both readings are tried: `w-data` constrains the data, `w-root` the whole record.
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, mine } = await scenario()
const send = (client: string, data: Record<string, unknown>, label = `${client}.create ${data.handle}`) =>
  step(label, () => (sdk as any)[client].init().data({ access: mine, ...data }).hash().sign([{ keyPair }]).send())

await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'before' })

// Schemas: one that reads the data, one that reads the record, one for intents.
const dataSchema = { type: 'object', required: ['custom'], properties: { custom: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['person', 'company'] } } } } }
await send('schema', { handle: 'w-data', record: 'wallet', format: 'json-schema', schema: dataSchema })
await step('schema.read w-data', () => (sdk as any).schema.read('w-data'))
await send('schema', { handle: 'w-root', record: 'wallet', format: 'json-schema', schema: { type: 'object', required: ['data'], properties: { data: dataSchema } } })
await send('schema', { handle: 'bad-format', record: 'wallet', format: 'yaml', schema: {} })
await send('schema', { handle: 'bad-json-schema', record: 'wallet', format: 'json-schema', schema: { type: 'nonsense' } })
await send('schema', { handle: 'bad-record', record: 'ledger', format: 'json-schema', schema: {} })
await step('schema.list record=wallet', () => (sdk as any).schema.list({ 'data.record': 'wallet' }))

// Wallets once a wallet schema exists.
await send('wallet', { handle: 'no-schema' })
await send('wallet', { handle: 'unknown-schema', schema: 'nope' })
await send('wallet', { handle: 'data-ok', schema: 'w-data', custom: { kind: 'person' } })
await send('wallet', { handle: 'data-missing', schema: 'w-data' })
await send('wallet', { handle: 'data-enum', schema: 'w-data', custom: { kind: 'robot' } })
await send('wallet', { handle: 'root-ok', schema: 'w-root', custom: { kind: 'person' } })
await send('wallet', { handle: 'root-missing', schema: 'w-root' })
await step('wallet.read data-ok', () => sdk.wallet.read('data-ok'))

// An update of a wallet created before the schema, with and without one.
const before: any = (await sdk.wallet.read('before')).response.data
await step('wallet.update before, no schema', () =>
  sdk.wallet.from(before).data({ custom: { kind: 'person' } } as any).hash().sign([{ keyPair }]).send(),
)
await step('wallet.update before, schema', () =>
  sdk.wallet.from(before).data({ schema: 'w-data', custom: { kind: 'person' } } as any).hash().sign([{ keyPair }]).send(),
)

// Schema of another record kind; a schema for symbols leaves wallets' rule alone.
await send('schema', { handle: 's-plain', record: 'symbol', format: 'json-schema', schema: { type: 'object' } })
await send('wallet', { handle: 'wrong-kind', schema: 's-plain' })
await send('symbol', { handle: 'eur', factor: 100 })
await send('symbol', { handle: 'gbp', factor: 100, schema: 's-plain' })

// Updating a schema changes what it accepts. (The SDK's `data()` merges deeply, so the
// update adds a constraint rather than replacing the schema.)
await send('wallet', { handle: 'two-before', schema: 'w-data', custom: { kind: 'person', extra: 1 } })
const wData: any = (await (sdk as any).schema.read('w-data')).response.data
await step('schema.update w-data', () =>
  (sdk as any).schema.from(wData).data({ schema: { properties: { custom: { maxProperties: 1 } } } }).hash().sign([{ keyPair }]).send(),
)
await send('wallet', { handle: 'two-after', schema: 'w-data', custom: { kind: 'person', extra: 1 } })

// Intents: a schema on the claims, an intent without it, one with two invalid claims
// (amount over the maximum, symbol missing — the built-in schema accepts both shapes
// only if the symbol is there, so the second is an amount too large).
await send('schema', {
  handle: 'i-claims',
  record: 'intent',
  format: 'json-schema',
  schema: { type: 'object', required: ['claims'], properties: { claims: { type: 'array', items: { type: 'object', required: ['action', 'symbol', 'amount'], properties: { amount: { type: 'integer', maximum: 50 } } } } } },
})
const issue = (amount: number) => ({ action: 'issue', target: ref('data-ok'), symbol: ref('usd'), amount })
await send('intent', { handle: 'i-no-schema', claims: [issue(10)] })
await send('intent', { handle: 'i-bad', schema: 'i-claims', claims: [issue(60), issue(70)] })
await send('intent', { handle: 'i-ok', schema: 'i-claims', claims: [issue(10)] })
await new Promise((r) => setTimeout(r, 3000))
await step('intent.read i-ok', () => sdk.intent.read('i-ok'))
await step('balances data-ok', () => sdk.wallet.getBalances('data-ok'))
