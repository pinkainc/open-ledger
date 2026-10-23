// Labels corners the `labels` recording left open (TODO, Labels):
//
// - a record's changes: do the snapshots carry `meta.labels`, and the change of each proof?
// - invalid labels at creation: the error path (`/meta/proofs/<i>/custom/labels`?)
// - `$addToSet` with `$position`, `$sort`, `$slice`
// - the system proof that moves a `unique` label: which events it raises, and what the
//   loser's changes show. Two webhooks on the bridge port, filtered on b1, the loser.
//
// Bounded: no effect causes anything on the ledger, every webhook answers 202.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { startBridges } from '../bridge.js'
import { scenario } from './common.js'

const { sdk, keyPair, step, create, mine, LEDGER, secure } = await scenario()
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const s: any = sdk
const w: any = sdk.wallet

const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/labels2.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [],
  hooks: () => 202,
})

const read = (handle: string) => step(`wallet.read ${handle}`, () => w.read(handle))
async function label(handle: string, name: string, labels: unknown) {
  await step(`wallet.proof ${handle} ${name}`, async () => {
    const r: any = await w.read(handle)
    return w.from(r.response.data).sign([{ keyPair, custom: { labels, moment: new Date().toISOString() } }]).send()
  })
  return read(handle)
}
const createLabelled = (handle: string, labels: unknown, custom?: unknown) =>
  step(`wallet.create ${handle} labelled`, () => w.init().data({ handle, access: mine, ...(custom ? { custom } : {}) }).hash().sign([{ keyPair, custom: { labels } }]).send())
const changes = (handle: string) => step(`wallet.changes ${handle}`, () => w.with(handle).change.list())

// Changes of a labelled record.
await createLabelled('c', ['x'])
await label('c', '$push y', { $push: 'y' })
await label('c', '$pull x', { $pull: 'x' })
await changes('c')
await step('wallet.change c 1', () => w.with('c').change.read(1))
await step('wallet.change c 3', () => w.with('c').change.read(3))

// Invalid labels at creation, the second proof carrying them.
await createLabelled('bad1', 'solo')
await createLabelled('bad2', [1])
await step('wallet.create bad3 second proof labelled', () =>
  w.init().data({ handle: 'bad3', access: mine }).hash().sign([{ keyPair }, { keyPair, custom: { labels: { $set: ['a'] } } }]).send(),
)
await step('wallet.read bad1', () => w.read('bad1'))

// $addToSet with the $push modifiers.
await createLabelled('s', ['m', 'b'])
await label('s', '$addToSet $position', { $addToSet: { $each: ['a', 'b'], $position: 0 } })
await label('s', '$addToSet $sort', { $addToSet: { $each: ['c'], $sort: 1 } })
await label('s', '$addToSet $slice', { $addToSet: { $each: ['z'], $slice: 2 } })
await label('s', '$addToSet $slice -1', { $addToSet: { $each: ['a', 'q'], $slice: -1 } })

// A unique label moving from b1 to b2: the events of b1's system proof.
const hook = (name: string) => ({ schema: 'webhook', endpoint: `${BASE_URL}/hooks/${name}` })
const effect = (handle: string, signal: string, name: string) =>
  step(`effect.create ${handle}`, () => s.effect.init().data({ handle, signal, action: hook(name), filter: { 'wallet.data.handle': 'b1' }, access: mine }).hash().sign([{ keyPair }]).send())
await effect('e-proofs', 'wallet-proofs-added', 'proofs')
await effect('e-updated', 'wallet-updated', 'updated')
for (const h of ['b1', 'b2']) await create('wallet', { handle: h, custom: { kind: 'acct', owner: 'o1' } })
await step('policy.create labels-pref', () =>
  s.policy
    .init()
    .data({ handle: 'labels-pref', schema: 'labels', record: 'wallet', filter: { 'custom.kind': 'acct' }, values: [{ labels: ['pref'], unique: ['custom.owner'] }], access: mine })
    .hash()
    .sign([{ keyPair }])
    .send(),
)

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Off the record: waits until every delivery is final and the count holds.
async function quiet(seconds = 30) {
  let last = ''
  for (let i = 0; i < seconds * 2; i++) {
    await sleep(500)
    try {
      const rows = (await Promise.all(['e-proofs', 'e-updated'].map(async (e) => (await poller.effect.with(e).events.list({ page: { index: 0, limit: 50 } })).response.data.data))).flat()
      const now = rows.map((r: any) => r.meta.status).join(',')
      if (rows.every((r: any) => ['delivered', 'cancelled'].includes(r.meta.status)) && now === last) return
      last = now
    } catch {}
  }
  console.log('      events: not quiet')
}

await label('b1', 'pref', { $push: 'pref' })
await quiet()
await label('b2', 'pref taken', { $push: 'pref' })
await quiet()
await read('b1')
await changes('b1')
for (const e of ['e-proofs', 'e-updated']) await step(`events.list ${e}`, () => s.effect.with(e).events.list({ page: { index: 0, limit: 50 } }))

await sleep(2000)
await bridges.close()
