// Labels (structuring-data/labels): `meta.labels` is set by a proof's `custom.labels`,
// at creation or by a later proof, as an array or as one of the expressions of the docs
// ($push with $each/$position/$slice/$sort, $addToSet, $pull with $in, $pullAll, $pop).
// Then labels policies (structuring-data/labels-policies): `record` and `filter` pick
// the records, `values[].labels` is what may be attached, `unique` names data fields no
// two labelled records may share; with no matching policy any label goes.
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, mine } = await scenario()
const w: any = sdk.wallet

const read = (handle: string) => step(`wallet.read ${handle}`, () => w.read(handle))
async function label(handle: string, name: string, labels: unknown) {
  await step(`wallet.proof ${handle} ${name}`, async () => {
    const r: any = await w.read(handle)
    return w.from(r.response.data).sign([{ keyPair, custom: { labels, moment: new Date().toISOString() } }]).send()
  })
  return read(handle)
}
const createLabelled = (data: Record<string, unknown>, labels: unknown) =>
  step(`wallet.create ${data.handle} labelled`, () => w.init().data({ access: mine, ...data }).hash().sign([{ keyPair, custom: { labels } }]).send())

await createLabelled({ handle: 'w' }, ['active'])
await read('w')
await label('w', 'array', ['saving-account', 'preferred'])
await label('w', '$push', { $push: 'verified' })
await label('w', '$push $each', { $push: { $each: ['a', 'b'] } })
await label('w', '$push $position', { $push: { $each: ['first'], $position: 0 } })
await label('w', '$push $slice', { $push: { $each: ['z'], $position: 0, $slice: 3 } })
await label('w', '$push $sort', { $push: { $each: ['m'], $sort: -1 } })
await label('w', '$push $slice -2', { $push: { $each: ['x', 'y'], $slice: -2 } })
await label('w', '$addToSet', { $addToSet: 'x' })
await label('w', '$addToSet $each', { $addToSet: { $each: ['x', 'n', 'n'] } })
await label('w', '$pull', { $pull: 'x' })
await label('w', '$push dup', { $push: 'y' })
await label('w', '$pull $in', { $pull: { $in: ['y', 'zz'] } })
await label('w', 'array again', ['p', 'q', 'r', 's'])
await label('w', '$pullAll', { $pullAll: ['p', 'zz'] })
await label('w', '$pop 1', { $pop: 1 })
await label('w', '$pop -1', { $pop: -1 })
await label('w', 'empty array', [])
await label('w', '$pop empty', { $pop: 1 })
// Not in the docs.
await label('w', 'string', 'solo')
await label('w', 'unknown operator', { $set: ['a'] })
await label('w', 'two operators', { $push: 'a', $pull: 'b' })
await label('w', 'number in array', [1])
await label('w', 'null', null)
await step('wallet.list labels', () => w.list({ 'meta.labels': 'q' }))
await step('wallet.list labels $in', () => w.list({ 'meta.labels': { $in: ['r', 's'] } }))

// A label on a symbol and on an intent, through a proof.
await create('symbol', { handle: 'usd', factor: 100 })
await step('symbol.proof usd labelled', async () => {
  const r: any = await (sdk as any).symbol.read('usd')
  return (sdk as any).symbol.from(r.response.data).sign([{ keyPair, custom: { labels: ['money'] } }]).send()
})
await step('symbol.read usd', () => (sdk as any).symbol.read('usd'))
await step('intent.create i1 labelled', () =>
  sdk.intent.init().data({ handle: 'i1', claims: [{ action: 'issue', target: ref('w'), symbol: ref('usd'), amount: 1 }], access: mine } as any).hash().sign([{ keyPair, custom: { labels: ['payroll'] } }]).send(),
)
await new Promise((r) => setTimeout(r, 3000))
await step('intent.read i1', () => sdk.intent.read('i1'))

// Labels policies.
for (const h of ['a1', 'a2', 'a3']) await create('wallet', { handle: h, custom: { kind: 'account', owner: h === 'a3' ? 'o2' : 'o1' } })
await create('wallet', { handle: 'n1', custom: { kind: 'card' } })
await label('a1', 'other before policy', ['other'])
await step('policy.create labels-acc', () =>
  (sdk as any).policy
    .init()
    .data({
      handle: 'labels-acc',
      schema: 'labels',
      record: 'wallet',
      filter: { 'custom.kind': 'account' },
      values: [{ labels: ['preferred'], unique: ['custom.owner'] }, { labels: ['saving'] }],
      access: mine,
    })
    .hash()
    .sign([{ keyPair }])
    .send(),
)
await step('policy.read labels-acc', () => (sdk as any).policy.read('labels-acc'))
await label('a1', 'preferred', { $push: 'preferred' })
await label('a1', 'unlisted', { $push: 'gold' })
await label('a1', 'saving', { $push: 'saving' })
await label('a2', 'preferred taken', { $push: 'preferred' })
await label('a3', 'preferred other owner', { $push: 'preferred' })
await label('n1', 'no policy', { $push: 'anything' })
await label('a1', 'pull preferred', { $pull: 'preferred' })
await label('a2', 'preferred freed', { $push: 'preferred' })
await label('a1', 'pull other (unlisted, already there)', { $pull: 'other' })
await label('a3', 'replace with array', ['saving'])
await createLabelled({ handle: 'a4', custom: { kind: 'account', owner: 'o3' } }, ['gold'])
await read('a4')
await createLabelled({ handle: 'a5', custom: { kind: 'account', owner: 'o3' } }, ['preferred'])
await read('a5')
await step('policy.create labels-bad', () =>
  (sdk as any).policy.init().data({ handle: 'labels-bad', schema: 'labels', record: 'wallet', values: [{ unique: ['x'] }], access: mine }).hash().sign([{ keyPair }]).send(),
)
