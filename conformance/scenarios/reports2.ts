// Report statuses and assets (follows `reports`, which found that the reference checks
// status changes — `Proof contains invalid status change, from pending to settled` —
// and validates assets against its reporting bucket, `ledger-reports-stg`).
//
// Questions: the whole transition table (each of created, pending, completed,
// rejected, settled to each), whether a refused or repeated status leaves a proof or a
// change, and which assets a `completed` proof may carry (the documented path in the
// bucket, another path, another scheme, no handle, none), and what a download of a
// valid asset answers.
//
// Client proofs only: no bridge, no effect, nothing runs on its own.
import { signJWT } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { sdk, keyPair, step, mine, LEDGER, BASE } = await scenario()
const s: any = sdk
const BUCKET = 'ledger-reports-stg'
const signed = (b: any) => b.hash().sign([{ keyPair }]).send()

await step('schema.create plain-report', () =>
  signed(
    s.schema.init().data({
      handle: 'plain-report',
      record: 'report',
      format: 'json-schema',
      schema: { type: 'object', required: ['custom'], properties: { custom: { type: 'object', properties: { note: { type: 'string' } } } } },
      access: mine,
    }),
  ),
)

const create = (handle: string) => step(`report.create ${handle}`, () => signed(s.report.init().data({ handle, schema: 'plain-report', custom: { note: handle }, access: mine })))
const prove = (name: string, handle: string, custom: Record<string, unknown>) =>
  step(`report.sign ${name}`, async () => {
    const r = (await s.report.read(handle)).response.data
    return s.report.from(r).hash().sign([{ keyPair, custom: { moment: new Date().toISOString(), ...custom } }]).send()
  })

// To reach a status from `created`, the shortest path the docs give.
const PATH: Record<string, string[]> = {
  created: [],
  pending: ['pending'],
  completed: ['pending', 'completed'],
  rejected: ['pending', 'rejected'],
  settled: ['pending', 'completed', 'settled'],
}
const STATUSES = ['created', 'pending', 'completed', 'rejected', 'settled']
for (const from of STATUSES)
  for (const to of STATUSES) {
    const h = `t-${from}-${to}`
    await create(h)
    for (const status of PATH[from]) await prove(`${h} setup ${status}`, h, { status })
    await prove(`${from} to ${to}`, h, { status: to })
    await step(`report.read ${h}`, () => s.report.read(h))
  }
await step('report.changes t-pending-pending', () => s.report.with('t-pending-pending').change.list())

// Assets on `completed`, from `pending`.
const assetPath = async (handle: string, asset: string) => {
  const r = (await s.report.read(handle)).response.data
  return `gs://${BUCKET}/ledgers/${LEDGER}/schemas/plain-report/reports/${r.luid}/assets/${asset}`
}
const withAssets = async (h: string, assets: (path: (asset: string) => Promise<string>) => Promise<unknown[]>) => {
  await create(h)
  await prove(`${h} pending`, h, { status: 'pending' })
  const list = await assets((a) => assetPath(h, a)).catch(() => [])
  await prove(`${h} completed`, h, { status: 'completed', assets: list })
  await step(`report.read ${h}`, () => s.report.read(h))
}
await withAssets('a-documented', async (p) => [{ handle: 'report.csv', output: await p('report.csv') }])
await withAssets('a-two', async (p) => [
  { handle: 'a.csv', output: await p('a.csv') },
  { handle: 'b.json', output: await p('b.json') },
])
await withAssets('a-other-path', async () => [{ handle: 'report.csv', output: `gs://${BUCKET}/elsewhere/report.csv` }])
await withAssets('a-name-differs', async (p) => [{ handle: 'report.csv', output: await p('other.csv') }])
await withAssets('a-https', async () => [{ handle: 'report.csv', output: 'https://example.com/report.csv' }])
await withAssets('a-no-handle', async (p) => [{ output: await p('report.csv') }])
await withAssets('a-empty', async () => [])
// Assets on a status other than `completed`.
await create('a-on-pending')
await prove('a-on-pending pending with assets', 'a-on-pending', { status: 'pending', assets: [{ handle: 'report.csv', output: await assetPath('a-on-pending', 'report.csv').catch(() => '') }] })
await prove('a-on-pending without status, with assets', 'a-on-pending', { assets: [{ handle: 'x.csv', output: await assetPath('a-on-pending', 'x.csv').catch(() => '') }] })
await step('report.read a-on-pending', () => s.report.read('a-on-pending'))

// The download of an asset the ledger accepted (the file itself was never written).
async function raw(name: string, path: string) {
  const iat = Math.floor(Date.now() / 1000)
  const jwt = await signJWT({ iat, exp: iat + 300, iss: keyPair.public, aud: LEDGER, sub: `signer:${keyPair.public}` }, keyPair.secret, keyPair.public)
  return step(name, async () => {
    const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${jwt}`, 'x-ledger': LEDGER } })
    const text = await res.text()
    console.log(`      ${res.status} ${res.headers.get('content-type') ?? ''} ${res.headers.get('content-disposition') ?? ''} ${text.slice(0, 160).replace(/\n/g, '\\n')}`)
  })
}
await raw('asset download', '/reports/a-documented/assets/report.csv')
await raw('asset download unknown', '/reports/a-documented/assets/nope.csv')
await raw('asset download by luid', `/reports/${(await s.report.read('a-documented').catch(() => undefined))?.response?.data?.luid}/assets/report.csv`)
await raw('asset download unknown report', '/reports/ghost/assets/report.csv')
