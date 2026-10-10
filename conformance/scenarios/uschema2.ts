// Schema `extend` (spec: schema-data.extend, "handle of another schema to inherit and
// extend"; SDK: "inherit all rules and constraints from the extended one"). Open
// questions: is the parent's schema checked as well as the child's, along a chain?
// What does an unknown parent, or one for another record kind, get? Which errors come
// back when both fail? A cycle is left out: it could make the reference loop.
import { scenario } from './common.js'

const { sdk, keyPair, step, create, mine } = await scenario()
const s: any = sdk
const send = (client: string, data: Record<string, unknown>, label = `${client}.create ${data.handle}`) =>
  step(label, () => s[client].init().data({ access: mine, ...data }).hash().sign([{ keyPair }]).send())

await create('symbol', { handle: 'usd', factor: 100 })

const kind = { type: 'object', required: ['custom'], properties: { custom: { type: 'object', required: ['kind'], properties: { kind: { enum: ['person', 'company'] } } } } }
const tier = { type: 'object', required: ['custom'], properties: { custom: { type: 'object', required: ['tier'], properties: { tier: { type: 'number' } } } } }
const region = { type: 'object', properties: { custom: { type: 'object', required: ['region'] } } }

await send('schema', { handle: 'base', record: 'wallet', format: 'json-schema', schema: kind })
await send('schema', { handle: 'child', record: 'wallet', format: 'json-schema', schema: tier, extend: 'base' })
await step('schema.read child', () => s.schema.read('child'))
await send('schema', { handle: 'grandchild', record: 'wallet', format: 'json-schema', schema: region, extend: 'child' })

await send('wallet', { handle: 'child-ok', schema: 'child', custom: { kind: 'person', tier: 1 } })
await send('wallet', { handle: 'child-no-tier', schema: 'child', custom: { kind: 'person' } })
await send('wallet', { handle: 'child-no-kind', schema: 'child', custom: { tier: 1 } })
await send('wallet', { handle: 'child-bad-both', schema: 'child', custom: { kind: 'robot', tier: 'x' } })
await send('wallet', { handle: 'child-nothing', schema: 'child' })
await send('wallet', { handle: 'base-only', schema: 'base', custom: { kind: 'company' } })
await send('wallet', { handle: 'gc-ok', schema: 'grandchild', custom: { kind: 'person', tier: 2, region: 'eu' } })
await send('wallet', { handle: 'gc-no-kind', schema: 'grandchild', custom: { tier: 2, region: 'eu' } })
await send('wallet', { handle: 'gc-no-region', schema: 'grandchild', custom: { kind: 'person', tier: 2 } })

// Parents that cannot be.
await send('schema', { handle: 'orphan', record: 'wallet', format: 'json-schema', schema: tier, extend: 'nope' })
await send('schema', { handle: 's-sym', record: 'symbol', format: 'json-schema', schema: { type: 'object' } })
await send('schema', { handle: 'cross', record: 'wallet', format: 'json-schema', schema: tier, extend: 's-sym' })
await send('wallet', { handle: 'cross-use', schema: 'cross', custom: { tier: 1 } })
await send('schema', { handle: 'self', record: 'wallet', format: 'json-schema', schema: tier, extend: 'self' })

// Adding `extend` by update, and changing the parent afterwards.
await send('schema', { handle: 'late', record: 'wallet', format: 'json-schema', schema: tier })
const late: any = (await s.schema.read('late')).response.data
await step('schema.update late extends base', () => s.schema.from(late).data({ extend: 'base' }).hash().sign([{ keyPair }]).send())
await send('wallet', { handle: 'late-no-kind', schema: 'late', custom: { tier: 1 } })
const base: any = (await s.schema.read('base')).response.data
await step('schema.update base needs a name', () =>
  s.schema.from(base).data({ schema: { properties: { custom: { required: ['kind', 'name'] } } } }).hash().sign([{ keyPair }]).send(),
)
await send('wallet', { handle: 'child-no-name', schema: 'child', custom: { kind: 'person', tier: 1 } })
// Only wallet schemas: the system ones share one moment, and the reference lists
// those ties in no fixed order (two recordings disagree).
await step('schema.list record=wallet', () => s.schema.list({ 'data.record': 'wallet' }))
