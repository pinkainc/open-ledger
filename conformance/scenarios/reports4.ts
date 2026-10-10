// Follow-up to `reports3`, which found the asset path's ledger, schema and luid
// checked, a report in a domain completed with `/domains/{d}/` in the path, a status
// policy value needing `quorum`, and `report-dropped` raised (its webhook did not
// resolve then). Here:
// - a report in a domain completed with the plain path, and one outside any domain
//   completed with a domain path;
// - a status policy on reports with a quorum;
// - the `report-dropped` event as a webhook receives it.
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
  out: process.env.BRIDGE_OUT ?? '.rec/reports4.bridge.jsonl',
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

  const luid = (h: string) => luidOf(h)
  await step('domain.create emea', () => signed(s.domain.init().data({ handle: 'emea', access: mine })))
  const path = (domain: string | undefined, l: string) =>
    `gs://${BUCKET}/ledgers/${LEDGER}/${domain ? `domains/${domain}/` : ''}schemas/plain-report/reports/${l}/assets/r.csv`
  for (const [h, domain] of [['plain-in-domain@emea', undefined], ['domain-outside', 'emea'], ['other-domain@emea', 'apac']] as const) {
    await create(h)
    await prove(`${h} pending`, h, { status: 'pending' })
    const l = await luid(h)
    await prove(`${h} completed`, h, { status: 'completed', assets: [{ handle: 'r.csv', output: path(domain, l) }] })
    await step(`report.read ${h}`, () => s.report.read(h))
  }

  // A status policy on reports: only `other` may set `completed`.
  await step('policy.create report-status', () =>
    signed(s.policy.init().data({ handle: 'report-status', schema: 'status', record: 'report', values: [{ status: 'pending', quorum: [{ public: keyPair.public }] }, { status: 'completed', quorum: [{ public: other.public }] }], access: mine })),
  )
  await create('st')
  await prove('st pending', 'st', { status: 'pending' })
  await prove('st completed by the operator (not in quorum)', 'st', { status: 'completed', assets: [] })
  await step('report.read st after the operator', () => s.report.read('st'))
  await prove('st completed by other (quorum)', 'st', { status: 'completed', assets: [] }, other)
  await step('report.read st', () => s.report.read('st'))

  // Drop: the `report-dropped` event at the webhook.
  await create('gone')
  await step('report.drop gone', () => signed(s.report.drop('gone')))
  await new Promise((r) => setTimeout(r, 5000))
  await step('effect events on-dropped', () => s.effect.with('on-dropped').events.list())
} finally {
  await bridges.close()
}
