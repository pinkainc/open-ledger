// Edges of two-phase commit that l5–l7 left open (TODO L6, L8):
//
// - i-race: debits on two bridges; bank1 fails its prepare at once, bank2 accepts the
//   call and holds its `prepared`. What happens to bank2's pending debit, and what does
//   the ledger answer when bank2's `prepared` arrives after the intent was aborted?
// - i-open: bank1 prepares a credit and never confirms the commit. Is the commit sent
//   again after a while (reconciliation), or does the intent stay `committed`?
// - i-501a, i-501b: bank2 answers a prepare 501, so the delivery is `cancelled`. Does
//   the deprecated bulk retry (`activate`) send it again? And `retry` by age?
//
// Bounded: every failing call is either answered 501 (no retries) or reported once;
// nothing forwards. Waits are off the record (DIRECT).
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { ref, scenario } from './common.js'

// No intent here should expire while it is watched (a minute is a second on our server).
const { sdk, keyPair, step, create, LEDGER, secure } = await scenario({ expiryMinutes: 60 })
// Our server has no reconciliation to wait for; the reference gets three minutes.
const recording = !/127\.0\.0\.1|localhost/.test(process.env.DIRECT ?? '')
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const [key1, key2] = [await createKeyPair(), await createKeyPair()]
const intentOf = (entry: any) => entry?.intent?.data?.handle

const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/edges2pc.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [
    {
      handle: 'bank1',
      prefix: '/bank1',
      keyPair: key1,
      decide: (entry) =>
        intentOf(entry) === 'i-race' ? { status: 'failed', reason: 'bridge.account-insufficient-balance', detail: 'Account acc1 has no funds' } : { status: 'prepared' },
      report: (_entry, action, intent) => !(action === 'commit' && intent?.data?.handle === 'i-open'),
    },
    {
      handle: 'bank2',
      prefix: '/bank2',
      keyPair: key2,
      decide: (entry) => {
        const i = intentOf(entry)
        if (i === 'i-race') return { hold: { status: 'prepared' } }
        if (i === 'i-501a' || i === 'i-501b') return { httpFirst: 501, then: { status: 'prepared' } }
        return { status: 'prepared' }
      },
    },
  ],
})
const mine = [{ action: 'any', signer: { public: keyPair.public } }]
const s: any = sdk
for (const [h, k] of [['bank1', key1], ['bank2', key2]] as const) {
  await step(`bridge.create ${h}`, () => s.bridge.init().data({ handle: h, schema: 'rest', config: { server: `${BASE_URL}/${h}/v2` }, secure: [], access: mine }).hash().sign([{ keyPair }]).send())
  await step(`signer.create ${h}`, () => s.signer.init().data({ handle: h, public: k.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
}
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'acc1', bridge: 'bank1' })
await create('wallet', { handle: 'acc2', bridge: 'bank2' })

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(handle: string, ok: (i: any) => boolean, seconds = 60) {
  for (let n = 0; n < seconds * 2; n++) {
    try {
      const i = (await poller.intent.read(handle)).response.data
      if (ok(i)) return i.meta.status
    } catch {}
    await sleep(500)
  }
  return 'timeout'
}
const final = (i: any) => ['completed', 'rejected'].includes(i.meta.status)
const deliveries = (bridge: string, linked: string) => poller.bridge.with(bridge).events.list({ 'data.linked': linked, page: { index: 0, limit: 50 } } as any).then((r: any) => r.response.data.data)
async function quiet(bridge: string, linked: string, ok: (rows: any[]) => boolean) {
  for (let n = 0; n < 120; n++) {
    try {
      if (ok(await deliveries(bridge, linked))) return
    } catch {}
    await sleep(500)
  }
  console.log(`      ${bridge} ${linked}: condition not reached`)
}
const send = (handle: string, claims: unknown[]) =>
  step(`intent.create ${handle}`, () => sdk.intent.init().data({ handle, claims, access: mine } as any).hash().sign([{ keyPair }]).send())
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref('usd'), amount })

// Issues call no bridge (l5); a bridged wallet's debit needs its balance here first.
await send('i-fund', ['alice', 'acc1', 'acc2'].map((w) => ({ action: 'issue', target: ref(w), symbol: ref('usd'), amount: 100 })))
console.log(`      settled: ${await until('i-fund', final)}`)

// ---- a debit fails while another bridge's debit is still pending, then a late prepared
await send('i-race', [t('acc1', 'alice', 7), t('acc2', 'alice', 9)])
console.log(`      reached: ${await until('i-race', (i) => ['aborted', 'rejected'].includes(i.meta.status))}`)
await sleep(3000)
await step('intent.read i-race (bank2 silent)', () => sdk.intent.read('i-race'))
await bridges.release()
await sleep(4000)
console.log(`      settled: ${await until('i-race', final)}`)
await step('intent.read i-race (late prepared)', () => sdk.intent.read('i-race'))
await step('events.list bank2 i-race', () => s.bridge.with('bank2').events.list({ 'data.linked': 'i-race' }))
await step('balances alice', () => sdk.wallet.getBalances('alice'))

// ---- a commit that is never confirmed: does anything come back for it?
await send('i-open', [t('alice', 'acc1', 5)])
console.log(`      reached: ${await until('i-open', (i) => i.meta.status === 'committed')}`)
// Off the record, watching whether the bridge hears of i-open again.
await sleep(recording ? 180_000 : 3000)
await step('intent.read i-open (3 min)', () => sdk.intent.read('i-open'))
await step('events.list bank1 i-open', () => s.bridge.with('bank1').events.list({ 'data.linked': 'i-open' }))

// ---- bulk retries and a cancelled delivery
const events = s.bridge.with('bank2').events
await send('i-501a', [t('acc2', 'alice', 1)])
await quiet('bank2', 'i-501a', (rows) => rows.some((r) => r.meta.status === 'cancelled'))
await step('bridge.activate', () => s.bridge.with('bank2').activate({ maxAge: 60 }).hash().sign([{ keyPair }]).send())
await sleep(6000)
await step('events.list i-501a after activate', () => events.list({ 'data.linked': 'i-501a' }))
await step('intent.read i-501a after activate', () => sdk.intent.read('i-501a'))

await send('i-501b', [t('acc2', 'alice', 2)])
await quiet('bank2', 'i-501b', (rows) => rows.some((r) => r.meta.status === 'cancelled'))
await step('events.retry by age', () => events.retry({ maxAge: 60 }).hash().sign([{ keyPair }]).send())
await sleep(6000)
await step('events.list i-501b after retry', () => events.list({ 'data.linked': 'i-501b' }))
await step('intent.read i-501b after retry', () => sdk.intent.read('i-501b'))
await step('events.list i-501a after retry', () => events.list({ 'data.linked': 'i-501a' }))

await sleep(3000)
await bridges.close()
