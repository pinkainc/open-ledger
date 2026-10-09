// Domains (about-domains): a namespace a record joins at creation, by a `@domain`
// handle suffix or a proof's `custom.domain` (which wins), readable in `meta.domain`.
// Here: the domain records themselves, how records get their domain, subdomains, the
// list filter, and what an intent across domains shows in `meta.domains`. Access
// inheritance needs restrictive ledger rules and is not in this scenario.
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, intent, mine } = await scenario()
const s: any = sdk
const make = (client: string, data: Record<string, unknown>, custom?: Record<string, unknown>, label = `${client}.create ${data.handle}${custom ? ' ' + JSON.stringify(custom) : ''}`) =>
  step(label, () => s[client].init().data({ access: mine, ...data }).hash().sign([{ keyPair, ...(custom ? { custom } : {}) }]).send())

await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'before' })

await make('domain', { handle: 'payments' })
await step('domain.read payments', () => s.domain.read('payments'))
await make('domain', { handle: 'payments' }, undefined, 'domain.create duplicate')
await make('domain', { handle: 'eu@payments' })
await make('domain', { handle: 'retail' }, { domain: 'payments' })
await make('domain', { handle: 'x', colour: 'red' }, undefined, 'domain.create unknown property')
await step('domain.list', () => s.domain.list())

await make('wallet', { handle: 'treasury@payments' })
await make('wallet', { handle: 'ops' }, { domain: 'payments' })
await make('wallet', { handle: 'acc@payments' }, { domain: 'retail' })
await make('wallet', { handle: 'w@eu@payments' })
await make('wallet', { handle: 'x@nowhere' })
await make('wallet', { handle: 'y' }, { domain: 'nowhere' })
await make('wallet', { handle: 'plain' })
await step('wallet.read treasury@payments', () => s.wallet.read('treasury@payments'))
await step('wallet.read ops', () => s.wallet.read('ops'))
await step('wallet.read acc@payments', () => s.wallet.read('acc@payments'))
await step('wallet.read plain', () => s.wallet.read('plain'))
await step('wallet.list meta.domain=payments', () => s.wallet.list({ 'meta.domain': 'payments' }))
await step('domain.list meta.domain=payments', () => s.domain.list({ 'meta.domain': 'payments' }))

const d: any = (await s.domain.read('payments')).response.data
await step('domain.update payments', () => s.domain.from(d).data({ custom: { name: 'Payments' } }).hash().sign([{ keyPair }]).send())

// A symbol in a domain, and an intent between wallets of two domains.
await make('symbol', { handle: 'eur@payments', factor: 100 })
await intent('issue to treasury', 'i-dom', [{ action: 'issue', target: ref('treasury@payments'), symbol: ref('usd'), amount: 10 }])
await intent('treasury to plain', 'i-cross', [{ action: 'transfer', source: ref('treasury@payments'), target: ref('plain'), symbol: ref('usd'), amount: 3 }])
await step('intent.list meta.domains=payments', () => s.intent.list({ 'meta.domains': 'payments' }))
