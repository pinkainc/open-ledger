// Which list filters the reference supports (TODO: "Unsupported list filters"). Seen so
// far: `data.origin` on intents, `data.signal` on effects and `meta.domain` on domains
// answer 400 `api.query-malformed` `Unsupported filters: '<f>'`. Here every kind's list
// is asked for each field below, one at a time, with a value that matches nothing
// (so a supported filter answers an empty page), then a few operators and two filters
// at once, to see whether the message names one field or all.
import { ref, scenario } from './common.js'

const { sdk, step, create, intent } = await scenario()
const s: any = sdk

await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'w1' })
await intent('issue', 'i1', [{ action: 'issue', target: ref('w1'), symbol: ref('usd'), amount: 1 }])

const KINDS = ['symbol', 'wallet', 'intent', 'signer', 'circle', 'policy', 'bridge', 'schema', 'effect', 'domain', 'report', 'anchor']
const FIELDS = [
  'luid',
  'hash',
  'data.handle',
  'data.custom.x',
  'data.schema',
  'data.access',
  'data.record',
  'data.symbol',
  'data.wallet',
  'data.target',
  'data.origin',
  'data.signal',
  'data.public',
  'data.parent',
  'data.claims.symbol',
  'data.unknown',
  'meta.status',
  'meta.domain',
  'meta.domains',
  'meta.owners',
  'meta.moment',
  'meta.thread',
  'meta.unknown',
  'unknown',
]
for (const kind of KINDS) for (const field of FIELDS) await step(`${kind}.list ${field}`, () => s[kind].list({ [field]: 'zz-none' }))

// Operators on a supported field, and two unsupported fields at once.
await step('wallet.list data.handle.$in', () => s.wallet.list({ 'data.handle.$in': ['w1', 'zz'] }))
await step('wallet.list data.handle.$regex', () => s.wallet.list({ 'data.handle.$regex': '^w' }))
await step('wallet.list data.handle.$foo', () => s.wallet.list({ 'data.handle.$foo': 'w1' }))
await step('intent.list two unsupported', () => s.intent.list({ 'data.origin': 'x', 'data.unknown': 'y' }))
await step('intent.list $plainTextQuery', () => s.intent.list({ $plainTextQuery: 'i1' }))
