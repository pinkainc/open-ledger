// Effects (docs: register-effect, handle-webhooks): a record that reacts to a ledger
// event (`signal`, narrowed by `filter`) by calling a webhook or a bridge with the trait
// `events`. Each call is a delivery like a bridge's (`/effects/{id}/events`). Questions
// this records:
//
// - the effect record, and what happens with a bad signal, an unknown bridge, a bridge
//   without traits and one whose traits leave out `effects` (docs say the trait is
//   `events`; the reference knows only `effects`, recorded)
// - the event each signal sends (balance-received, intent-created, intent-updated,
//   wallet-created): body, handle, which record it carries, how often it fires
// - a webhook answering 500 once (retried), and 501 (cancelled), then retried by handle
// - delivery lists, filters, find, retry, the deprecated activate, update and drop
//
// Bounded on purpose: no effect causes an intent, every failing endpoint either
// recovers or answers 501, and intent-updated is filtered to one intent.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, LEDGER, secure } = await scenario()
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const evKey = await createKeyPair()

// /hooks/flaky fails the first call of each event; /hooks/closed answers 501 until opened.
const seen = new Set<string>()
let closedIsClosed = true
const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/effects.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [
    { handle: 'ev', prefix: '/ev', keyPair: evKey, decide: () => ({ status: 'prepared' }) },
    { handle: 'deb', prefix: '/deb', keyPair: evKey, decide: () => ({ status: 'prepared' }) },
  ],
  hooks: (path, event) => {
    if (path === '/hooks/flaky') {
      const k = String(event?.data?.handle)
      if (!seen.has(k)) return seen.add(k), 500
    }
    if (path === '/hooks/closed' && closedIsClosed) return 501
    return 202
  },
})
const mine = [{ action: 'any', signer: { public: keyPair.public } }]
const s: any = sdk
const effect = (name: string, data: Record<string, unknown>) =>
  step(`effect.create ${name}`, () => s.effect.init().data({ access: mine, ...data }).hash().sign([{ keyPair }]).send())
const hook = (name: string) => ({ schema: 'webhook', endpoint: `${BASE_URL}/hooks/${name}` })

await step('bridge.create ev', () =>
  s.bridge.init().data({ handle: 'ev', schema: 'rest', config: { server: `${BASE_URL}/ev/v2` }, secure: [], traits: ['effects'], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('bridge.create deb', () =>
  s.bridge.init().data({ handle: 'deb', schema: 'rest', config: { server: `${BASE_URL}/deb/v2` }, secure: [], traits: ['debits'], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('bridge.create plain', () =>
  s.bridge.init().data({ handle: 'plain', schema: 'rest', config: { server: `${BASE_URL}/plain/v2` }, secure: [], access: mine }).hash().sign([{ keyPair }]).send(),
)
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'bob' })

// Errors first: nothing is delivered for them.
await effect('bad signal', { handle: 'e-bad', signal: 'no-such-signal', action: hook('ok') })
await effect('unknown bridge', { handle: 'e-nobridge', signal: 'wallet-created', action: { schema: 'bridge', bridge: 'nope' } })
await effect('bridge without events', { handle: 'e-plain', signal: 'wallet-created', action: { schema: 'bridge', bridge: 'plain' } })
await effect('bridge without effects trait', { handle: 'e-deb', signal: 'wallet-created', action: { schema: 'bridge', bridge: 'deb' } })
await effect('webhook without endpoint', { handle: 'e-noendpoint', signal: 'wallet-created', action: { schema: 'webhook' } })

await effect('received by bob', {
  handle: 'e-received',
  signal: 'balance-received',
  filter: { 'wallet.data.handle': 'bob', 'symbol.data.handle': 'usd' },
  action: hook('received'),
})
await effect('received to bridge', { handle: 'e-bridge', signal: 'balance-received', filter: { 'wallet.data.handle': 'bob' }, action: { schema: 'bridge', bridge: 'ev' } })
await effect('intent created', { handle: 'e-created', signal: 'intent-created', action: hook('flaky') })
await effect('intent updated', { handle: 'e-updated', signal: 'intent-updated', filter: { 'intent.data.handle': 'i-move' }, action: hook('updated') })
await effect('wallet created', { handle: 'e-wallet', signal: 'wallet-created', action: hook('closed') })
await effect('duplicate', { handle: 'e-wallet', signal: 'wallet-created', action: hook('closed') })

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
async function settle(handle: string) {
  for (let i = 0; i < 80; i++) {
    try {
      const r: any = (await poller.intent.read(handle)).response.data
      if (['completed', 'rejected'].includes(r.meta.status)) return r.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
// Off the record: waits until every delivery of the effects is final and the count holds.
async function quiet(effects: string[]) {
  let last = ''
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const rows = (await Promise.all(effects.map(async (e) => (await poller.effect.with(e).events.list({ page: { index: 0, limit: 50 } })).response.data.data))).flat()
      const now = rows.map((r: any) => r.meta.status).join(',')
      if (rows.length && rows.every((r: any) => ['delivered', 'cancelled'].includes(r.meta.status)) && now === last) return
      last = now
    } catch {}
  }
  console.log(`      ${effects.join(', ')}: not quiet`)
}
const ALL = ['e-received', 'e-bridge', 'e-created', 'e-updated', 'e-wallet', 'e-plain', 'e-deb', 'e-nobridge']
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref('usd'), amount })
async function move(handle: string, claims: unknown[]) {
  await step(`intent.create ${handle}`, () => sdk.intent.init().data({ handle, claims, access: mine } as any).hash().sign([{ keyPair }]).send())
  console.log(`      settled: ${await settle(handle)}`)
}

await create('wallet', { handle: 'carol' })
await move('i-fund', [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 100 }])
await move('i-move', [t('alice', 'bob', 30)])
await quiet(ALL)

await step('effect.read', () => s.effect.read('e-received'))
await step('effect.list', () => s.effect.list())
await step('effect.list by signal', () => s.effect.list({ 'data.signal': 'intent-created' }))
const ev = (e: string) => s.effect.with(e).events
for (const e of ALL) await step(`events.list ${e}`, () => ev(e).list({ page: { index: 0, limit: 50 } }))
await step('events.list delivered of i-move', () => ev('e-created').list({ 'meta.status': 'delivered', 'data.linked': 'i-move' }))
const cancelled = await step('events.list cancelled', () => ev('e-wallet').list({ 'meta.status': 'cancelled' }))
const handle = cancelled?.response?.data?.data?.[0]?.data?.handle ?? 'none'
await step('events.find cancelled', () => ev('e-wallet').find(handle))
await step('events.find on another effect', () => ev('e-received').find(handle))
await step('events.find unknown', () => ev('e-wallet').find('0000000000000nope'))
await step('events.retry unknown', () => ev('e-wallet').retry({ handle: '0000000000000nope' }).hash().sign([{ keyPair }]).send())
closedIsClosed = false
await step('events.retry cancelled', () => ev('e-wallet').retry({ handle }).hash().sign([{ keyPair }]).send())
await quiet(['e-wallet'])
await step('events.find retried', () => ev('e-wallet').find(handle))
await step('effect.activate', () => s.effect.with('e-wallet').activate({ maxAge: 60 }).hash().sign([{ keyPair }]).send())
await step('events.retry by age', () => ev('e-created').retry({ maxAge: 60 }).hash().sign([{ keyPair }]).send())

// Update narrows the filter to a wallet that receives nothing; drop removes the effect.
const current = await step('effect.read e-received', () => s.effect.read('e-received'))
const rec = current?.response?.data
if (rec)
  await step('effect.update', () =>
    s.effect.from(rec).data({ ...rec.data, parent: rec.hash, filter: { 'wallet.data.handle': 'carol' } }).hash().sign([{ keyPair }]).send(),
  )
await step('effect.changes', () => s.effect.with('e-received').change.list())
await step('effect.drop e-updated', () => s.effect.drop('e-updated').hash().sign([{ keyPair }]).send())
await step('effect.read dropped', () => s.effect.read('e-updated'))
await move('i-again', [t('alice', 'bob', 5)])
await quiet(['e-received', 'e-bridge', 'e-created'])
await step('events.list e-received after update', () => ev('e-received').list({ page: { index: 0, limit: 50 } }))
await step('events.list e-bridge after update', () => ev('e-bridge').list({ page: { index: 0, limit: 50 } }))

await new Promise((r) => setTimeout(r, 3000))
await bridges.close()
