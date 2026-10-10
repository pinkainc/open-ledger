// Signals the effects recording left open (TODO L8). Each effect calls a webhook on the
// bridge port, so the events themselves are in the bridge log:
//
// - `intent-proofs-added` and `wallet-proofs-added`: the payload (no filter: few intents)
// - `bridge-entry-created|updated|proofs-added`: raised at all, and with what
// - `wallet-limited`: a limit claim on bob
// - `intent-updated` of a bridged intent (i-bridged) and of a rejected one (i-over)
// - `balance-received` for two credits of one intent to dave: one event or two
// - a webhook that does not resolve on the network: the delivery's attempts and end
//
// Bounded: no effect causes an intent, one bridged intent, the unreachable webhook
// fires once (filter on erin) and gives up after the retry cap.
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
  out: process.env.BRIDGE_OUT ?? '.rec/signals2.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [{ handle: 'bank', prefix: '/bank', keyPair: bankKey, decide: () => ({ status: 'prepared' }) }],
  hooks: () => 202,
})
const mine = [{ action: 'any', signer: { public: keyPair.public } }]
const s: any = sdk
const hook = (name: string) => ({ schema: 'webhook', endpoint: `${BASE_URL}/hooks/${name}` })
const effect = (handle: string, signal: string, action: unknown, filter?: Record<string, unknown>) =>
  step(`effect.create ${handle}`, () => s.effect.init().data({ handle, signal, action, ...(filter ? { filter } : {}), access: mine }).hash().sign([{ keyPair }]).send())

await step('bridge.create bank', () => s.bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: `${BASE_URL}/bank/v2` }, secure: [], access: mine }).hash().sign([{ keyPair }]).send())
await step('signer.create bank', () => s.signer.init().data({ handle: 'bank', public: bankKey.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
await create('symbol', { handle: 'usd', factor: 100 })
for (const h of ['alice', 'bob', 'carol', 'dave']) await create('wallet', { handle: h })
await create('wallet', { handle: 'acc', bridge: 'bank' })

await effect('e-iproofs', 'intent-proofs-added', hook('iproofs'))
await effect('e-wproofs', 'wallet-proofs-added', hook('wproofs'))
await effect('e-entry-created', 'bridge-entry-created', hook('entry-created'))
await effect('e-entry-updated', 'bridge-entry-updated', hook('entry-updated'))
await effect('e-entry-proofs', 'bridge-entry-proofs-added', hook('entry-proofs'))
await effect('e-limited', 'wallet-limited', hook('limited'))
await effect('e-upd-bridged', 'intent-updated', hook('upd-bridged'), { 'intent.data.handle': 'i-bridged' })
await effect('e-upd-over', 'intent-updated', hook('upd-over'), { 'intent.data.handle': 'i-over' })
await effect('e-received', 'balance-received', hook('received'), { 'wallet.data.handle': 'dave' })
await effect('e-down', 'wallet-created', { schema: 'webhook', endpoint: 'https://open-ledger-conformance.invalid/hook' }, { 'wallet.data.handle': 'erin' })
const ALL = ['e-iproofs', 'e-wproofs', 'e-entry-created', 'e-entry-updated', 'e-entry-proofs', 'e-limited', 'e-upd-bridged', 'e-upd-over', 'e-received', 'e-down']

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function settle(handle: string) {
  for (let i = 0; i < 80; i++) {
    try {
      const r: any = (await poller.intent.read(handle)).response.data
      if (['completed', 'rejected'].includes(r.meta.status)) return r.meta.status
    } catch {}
    await sleep(500)
  }
  return 'timeout'
}
// Off the record: waits until every delivery of the effects is final and the count holds.
async function quiet(effects: string[], seconds = 60) {
  let last = ''
  for (let i = 0; i < seconds * 2; i++) {
    await sleep(500)
    try {
      const rows = (await Promise.all(effects.map(async (e) => (await poller.effect.with(e).events.list({ page: { index: 0, limit: 50 } })).response.data.data))).flat()
      const now = rows.map((r: any) => r.meta.status).join(',')
      if (rows.every((r: any) => ['delivered', 'cancelled'].includes(r.meta.status)) && now === last) return
      last = now
    } catch {}
  }
  console.log(`      ${effects.join(', ')}: not quiet`)
}
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref('usd'), amount })
async function move(handle: string, claims: unknown[]) {
  await step(`intent.create ${handle}`, () => sdk.intent.init().data({ handle, claims, access: mine } as any).hash().sign([{ keyPair }]).send())
  console.log(`      settled: ${await settle(handle)}`)
  // One intent's events at a time, so the log has them in a stable order.
  await quiet(ALL.filter((e) => e !== 'e-down'))
}

await move('i-fund', [
  { action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 100 },
  { action: 'issue', target: ref('bob'), symbol: ref('usd'), amount: 100 },
])
await move('i-two', [t('alice', 'dave', 3), t('bob', 'dave', 4)])
await move('i-bridged', [t('alice', 'acc', 5)])
await move('i-over', [t('carol', 'alice', 1)])
await move('i-limit', [{ action: 'limit', metric: 'minBalance', wallet: ref('bob'), symbol: ref('usd'), amount: -500 }])

const current = (await poller.wallet.read('carol')).response.data
await step('wallet.status carol', () => s.wallet.from(current).sign([{ keyPair, custom: { status: 'active' } }]).send())
await quiet(['e-wproofs'])

await create('wallet', { handle: 'erin' })
await quiet(['e-down'], 90)

const ev = (e: string) => s.effect.with(e).events
for (const e of ALL) await step(`events.list ${e}`, () => ev(e).list({ page: { index: 0, limit: 50 } }))
await step('intent.read i-bridged', () => sdk.intent.read('i-bridged'))

await sleep(3000)
await bridges.close()
