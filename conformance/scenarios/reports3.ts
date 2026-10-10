// What `reports` and `reports2` left open (TODO, Reports `(?)`):
// - an asset path naming another ledger or another report's luid: checked or not?
// - a report in a domain: does the documented path need `/domains/{d}/`?
// - a status policy on reports (`record: report`): applied as for wallets?
// - `report-dropped`: raised (an effect on it, to a webhook that only answers)?
// No asset is downloaded here: a file missing from the bucket drops the connection.
//
// needs-bridge — the bridge is only the webhook for `report-dropped`.
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { scenario } from './common.js'

const { sdk, keyPair, step, mine, LEDGER } = await scenario()
const s: any = sdk
const BUCKET = 'ledger-reports-stg'
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const signed = (b: any) => b.hash().sign([{ keyPair }]).send()
const other = await createKeyPair()

const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/reports3.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [],
})

try {
  await step('schema.create plain-report', () =>
    signed(s.schema.init().data({ handle: 'plain-report', record: 'report', format: 'json-schema', schema: { type: 'object' }, access: mine })),
  )
  await step('effect.create on report-dropped', () =>
    signed(s.effect.init().data({ handle: 'on-dropped', signal: 'report-dropped', action: { schema: 'webhook', endpoint: `${BASE_URL}/hooks/dropped` }, access: mine })),
  )
  const create = (handle: string, custom?: Record<string, unknown>) =>
    step(`report.create ${handle}${custom ? ' ' + JSON.stringify(custom) : ''}`, () =>
      s.report.init().data({ handle, schema: 'plain-report', access: mine }).hash().sign([{ keyPair, ...(custom ? { custom } : {}) }]).send(),
    )
  const prove = (name: string, handle: string, custom: Record<string, unknown>, key = keyPair) =>
    step(`report.sign ${name}`, async () => {
      const r = (await s.report.read(handle)).response.data
      return s.report.from(r).hash().sign([{ keyPair: key, custom: { moment: new Date().toISOString(), ...custom } }]).send()
    })
  const luidOf = async (h: string) => (await s.report.read(h)).response.data.luid
  const completeWith = async (h: string, output: (luid: string) => string) => {
    await create(h)
    await prove(`${h} pending`, h, { status: 'pending' })
    const luid = await luidOf(h)
    await prove(`${h} completed`, h, { status: 'completed', assets: [{ handle: 'r.csv', output: output(luid) }] })
    await step(`report.read ${h}`, () => s.report.read(h))
  }

  // Asset paths: another ledger, another report's luid, an invented luid.
  await create('donor')
  const donor = await luidOf('donor')
  await completeWith('p-other-ledger', (luid) => `gs://${BUCKET}/ledgers/some-other-ledger/schemas/plain-report/reports/${luid}/assets/r.csv`)
  await completeWith('p-other-luid', () => `gs://${BUCKET}/ledgers/${LEDGER}/schemas/plain-report/reports/${donor}/assets/r.csv`)
  await completeWith('p-invented-luid', () => `gs://${BUCKET}/ledgers/${LEDGER}/schemas/plain-report/reports/$rep.made-up/assets/r.csv`)
  await completeWith('p-other-schema', (luid) => `gs://${BUCKET}/ledgers/${LEDGER}/schemas/no-such-schema/reports/${luid}/assets/r.csv`)

  // A report in a domain, completed with and without `/domains/{d}/`.
  await step('domain.create emea', () => signed(s.domain.init().data({ handle: 'emea', access: mine })))
  await create('in-domain@emea')
  await step('report.read in-domain@emea', () => s.report.read('in-domain@emea'))
  await prove('in-domain pending', 'in-domain@emea', { status: 'pending' })
  const d = await luidOf('in-domain@emea')
  await prove('in-domain completed (domain path)', 'in-domain@emea', {
    status: 'completed',
    assets: [{ handle: 'r.csv', output: `gs://${BUCKET}/ledgers/${LEDGER}/domains/emea/schemas/plain-report/reports/${d}/assets/r.csv` }],
  })
  await prove('in-domain completed (plain path)', 'in-domain@emea', {
    status: 'completed',
    assets: [{ handle: 'r.csv', output: `gs://${BUCKET}/ledgers/${LEDGER}/schemas/plain-report/reports/${d}/assets/r.csv` }],
  })
  await step('report.read in-domain@emea after', () => s.report.read('in-domain@emea'))

  // A status policy on reports: only `other` may set `completed`.
  await step('policy.create report-status', () =>
    signed(s.policy.init().data({ handle: 'report-status', schema: 'status', record: 'report', values: [{ status: 'pending' }, { status: 'completed', quorum: [{ public: other.public }] }], access: mine })),
  )
  await create('st')
  await prove('st pending', 'st', { status: 'pending' })
  await prove('st completed by the operator (not in quorum)', 'st', { status: 'completed', assets: [] })
  await prove('st rejected (no value)', 'st', { status: 'rejected' })
  await prove('st completed by other (quorum)', 'st', { status: 'completed', assets: [] }, other)
  await step('report.read st', () => s.report.read('st'))

  // Drop: is `report-dropped` raised?
  await step('report.drop donor', () => signed(s.report.drop('donor')))
  await new Promise((r) => setTimeout(r, 4000))
  await step('effect events on-dropped', () => s.effect.with('on-dropped').events.list())
} finally {
  await bridges.close()
}
