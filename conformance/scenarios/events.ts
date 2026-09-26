// L8: event deliveries (docs: inspect-event-deliveries). Every call the ledger makes to
// a bridge is a delivery `$evd` with a stable handle, a status (pending, delivered,
// failed, cancelled), a signed proof per attempt and the body it sent (`meta.output`).
// A bridge answers one prepare with 500 first (failed → delivered) and another with 501
// (cancelled: the ledger stops), which is then retried by handle.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, LEDGER, secure } = await scenario({ expiryMinutes: 10 })
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const bankKey = await createKeyPair()

const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/events.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [
    {
      handle: 'bank',
      prefix: '/bank',
      keyPair: bankKey,
      decide: (entry) => {
        const intent = entry?.intent?.data?.handle
        if (intent === 'i-500') return { httpFirst: 500, then: { status: 'prepared' } }
        if (intent === 'i-501') return { httpFirst: 501, then: { status: 'prepared' } }
        return { status: 'prepared' }
      },
    },
  ],
})
const mine = [{ action: 'any', signer: { public: keyPair.public } }]
const s: any = sdk
await step('bridge.create bank', () => s.bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: `${BASE_URL}/bank/v2` }, secure: [], access: mine }).hash().sign([{ keyPair }]).send())
await step('signer.create bank', () => s.signer.init().data({ handle: 'bank', public: bankKey.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'acc', bridge: 'bank' })

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
async function settle(handle: string, seconds = 40) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const r: any = (await poller.intent.read(handle)).response.data
      if (['completed', 'rejected'].includes(r.meta.status)) return r.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
const send = (name: string, handle: string, claims: unknown[]) =>
  step(`intent.create ${name}`, () => sdk.intent.init().data({ handle, claims } as any).hash().sign([{ keyPair }]).send())
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref('usd'), amount })
async function move(name: string, handle: string, claims: unknown[]) {
  await send(name, handle, claims)
  console.log(`      settled: ${await settle(handle)}`)
}
const directEvents = () => poller.bridge.with('bank').events
// Waits off the record until the deliveries of an intent satisfy `ok`.
async function until(linked: string, ok: (rows: any[]) => boolean) {
  for (let i = 0; i < 60; i++) {
    try {
      const rows = (await directEvents().list({ 'data.linked': linked, page: { index: 0, limit: 50 } } as any)).response.data.data
      if (ok(rows)) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`      ${linked}: condition not reached`)
}
const done = (rows: any[]) => rows.length > 0 && rows.every((r) => ['delivered', 'cancelled'].includes(r.meta.status))

await move('fund', 'i-fund', [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 100 }])
await move('delivered first time', 'i-ok', [t('alice', 'acc', 10)])
await until('i-ok', (rows) => rows.length === 4 && done(rows))
await move('delivered on the second attempt', 'i-500', [t('alice', 'acc', 5)])
await until('i-500', (rows) => rows.length === 4 && done(rows))
await send('the bridge answers 501', 'i-501', [t('alice', 'acc', 3)])
await until('i-501', (rows) => rows.some((r) => r.meta.status === 'cancelled'))

const events = s.bridge.with('bank').events
await step('events.list all', () => events.list({ page: { index: 0, limit: 50 } }))
const cancelled = await step('events.list cancelled', () => events.list({ 'meta.status': 'cancelled' }))
await step('events.list of i-500', () => events.list({ 'data.linked': 'i-500' }))
await step('events.list failed or cancelled', () => events.list({ 'meta.status.$in': ['failed', 'cancelled'] }))
const handle = cancelled?.response?.data?.data?.[0]?.data?.handle ?? 'none'
await step('events.find cancelled', () => events.find(handle))
await step('events.find unknown', () => events.find('0000000000000nope'))
await step('events.retry unknown', () => events.retry({ handle: '0000000000000nope' }).hash().sign([{ keyPair }]).send())
await step('events.retry cancelled', () => events.retry({ handle }).hash().sign([{ keyPair }]).send())
console.log(`      i-501 settled: ${await settle('i-501')}`)
await until('i-501', (rows) => rows.length === 4 && done(rows))
await step('intent.read i-501', () => sdk.intent.read('i-501'))
await step('events.find retried', () => events.find(handle))
await step('events.retry by age', () => events.retry({ maxAge: 60 }).hash().sign([{ keyPair }]).send())
await step('events.list of i-501', () => events.list({ 'data.linked': 'i-501' }))
await step('balances acc', () => sdk.wallet.getBalances('acc'))

await new Promise((r) => setTimeout(r, 3000))
await bridges.close()
