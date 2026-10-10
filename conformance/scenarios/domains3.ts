// What `domains` and `domains2` left open (TODO, Domains `(?)`):
// - updating a subdomain, whose stored data carries `domain` (the reference adds it),
//   while the domain schema has no such property;
// - an intent's `meta.domains` with several domains: claim order, or sorted?
// - the `meta.domains` of a forward intent (ours: always `[]`);
// - `domain.resolutionFromHandleEnabled: false`: does a `@domain` handle suffix still
//   put a record in a domain, and does a proof's `custom.domain`?
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, intent, mine } = await scenario()
const s: any = sdk
const make = (client: string, data: Record<string, unknown>, custom?: Record<string, unknown>, label = `${client}.create ${data.handle}${custom ? ' ' + JSON.stringify(custom) : ''}`) =>
  step(label, () => s[client].init().data({ access: mine, ...data }).hash().sign([{ keyPair, ...(custom ? { custom } : {}) }]).send())
const current = async (client: string, handle: string) => (await s[client].read(handle)).response.data

await create('symbol', { handle: 'usd', factor: 100 })
await make('domain', { handle: 'a' })
await make('domain', { handle: 'b' })
await make('domain', { handle: 'c@a' })
await step('domain.read c@a', () => s.domain.read('c@a'))

// Updating the subdomain as read (with its stored `domain`), and without it.
await step('domain.update c@a as read', async () => s.domain.from(await current('domain', 'c@a')).data({ custom: { n: 1 } }).hash().sign([{ keyPair }]).send())
await step('domain.update c@a without domain', async () => {
  const cur = await current('domain', 'c@a')
  const { domain: _d, ...data } = cur.data
  return s.domain.from({ ...cur, data: {} }).data({ ...data, custom: { n: 2 } }).hash().sign([{ keyPair }]).send()
})
await step('domain.update c@a moved to b', async () => s.domain.from(await current('domain', 'c@a')).data({ domain: 'b', custom: { n: 3 } }).hash().sign([{ keyPair }]).send())
await step('domain.read c@a after', () => s.domain.read('c@a'))
await step('domain.update a with domain', async () => s.domain.from(await current('domain', 'a')).data({ domain: 'b' }).hash().sign([{ keyPair }]).send())

// Wallets in three domains and none; intents naming them in different orders.
await make('wallet', { handle: 'wa@a' })
await make('wallet', { handle: 'wb@b' })
await make('wallet', { handle: 'wc' }, { domain: 'c@a' })
await make('wallet', { handle: 'plain' })
await intent('issue wb, wa, wc', 'i-order', [
  { action: 'issue', target: ref('wb@b'), symbol: ref('usd'), amount: 10 },
  { action: 'issue', target: ref('wa@a'), symbol: ref('usd'), amount: 10 },
  { action: 'issue', target: ref('wc'), symbol: ref('usd'), amount: 10 },
])
await intent('transfer wc to wb, wa to plain', 'i-order2', [
  { action: 'transfer', source: ref('wc'), target: ref('wb@b'), symbol: ref('usd'), amount: 1 },
  { action: 'transfer', source: ref('wa@a'), target: ref('plain'), symbol: ref('usd'), amount: 1 },
])
await intent('transfer plain to wa', 'i-order3', [{ action: 'transfer', source: ref('plain'), target: ref('wa@a'), symbol: ref('usd'), amount: 1 }])

// A forward route from a wallet in `a` to one in `b`: the forward intent's domains.
await make('wallet', { handle: 'dest@b' })
await make('wallet', { handle: 'fwd@a', routes: [{ action: 'forward', target: 'dest@b' }] })
await intent('wb to fwd@a (forwarded to dest@b)', 'i-fwd', [{ action: 'transfer', source: ref('wb@b'), target: ref('fwd@a'), symbol: ref('usd'), amount: 2 }])
await new Promise((r) => setTimeout(r, 3000))
await step('intent.list', () => s.intent.list())
await step('wallet.read dest@b', () => s.wallet.read('dest@b'))

// Resolution from handles turned off.
await step('ledger.update resolutionFromHandleEnabled false', async () => {
  const cur = (await s.ledger.read()).response.data
  return s.ledger.from(cur).data({ config: { ...cur.data.config, 'domain.resolutionFromHandleEnabled': false } }).hash().sign([{ keyPair }]).send()
})
await make('wallet', { handle: 'x@a' })
await make('wallet', { handle: 'y@nowhere' })
await make('wallet', { handle: 'z' }, { domain: 'a' })
await make('wallet', { handle: 'v@b' }, { domain: 'a' })
await step('wallet.read x@a', () => s.wallet.read('x@a'))
await step('wallet.read z', () => s.wallet.read('z'))
await step('wallet.read v@b', () => s.wallet.read('v@b'))
await intent('issue to x@a and z', 'i-off', [
  { action: 'issue', target: ref('x@a'), symbol: ref('usd'), amount: 1 },
  { action: 'issue', target: ref('z'), symbol: ref('usd'), amount: 1 },
])
await step('wallet.list meta.domain=a', () => s.wallet.list({ 'meta.domain': 'a' }))
