// Reports (docs: reporting/about-reports, reporting-bridge, reports-from-cli). A report
// (`$rep`) is a record whose type is a schema with `record: report`, its parameters in
// `data.custom`. The docs' protocol: creating one raises `report-created`; an effect
// on that signal sends the event to a reporting bridge (trait `effects`); the bridge
// signs `pending` on the report, then `completed` with `assets` (or `rejected`), and
// the ledger moves `meta.status` and fills `meta.assets`. The SDK downloads an asset
// through the ledger, `GET /reports/{id}/assets/{asset}` (not in the spec).
//
// Questions this records: the report record and its errors (no schema, unknown schema,
// invalid custom, duplicate), the event the bridge gets, what each status proof does
// (assets, countersignature, a status after `completed`, an unknown status), the
// asset download for a `gs://` and an `https://` output, `report-proofs-added`, the
// generic surface (list, access check, changes) and drop by DELETE and by POST.
//
// Bounded: the bridge answers `report-created` only, once per report, with two
// proofs; `report-proofs-added` goes to a webhook that only answers.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair, signJWT } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { scenario } from './common.js'

const { sdk, keyPair, step, mine, LEDGER, BASE, secure } = await scenario()
const s: any = sdk
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const repKey = await createKeyPair()

const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/reports.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  files: { 'web.csv': '"id","amount"\n"1","100"\n' },
  bridges: [
    {
      handle: 'rep',
      keyPair: repKey,
      decide: () => ({ status: 'prepared' }),
      // The reporting protocol of reporting-bridge.md: pending, then completed or rejected.
      afterEffect: async (_effect, event, { sdk: b, keyPair: k, log }) => {
        const report = event?.data?.report
        if (event?.data?.signal !== 'report-created' || !report) return
        const prove = async (custom: Record<string, unknown>) => {
          await new Promise((r) => setTimeout(r, 300))
          try {
            const res = await b.report.from(report).hash().sign([{ keyPair: k, custom: { moment: new Date().toISOString(), ...custom } }]).send()
            log({ proof: custom, answer: res.response.status, status: res.response.data?.meta?.status })
          } catch (e: any) {
            const res = e?.custom?.causedBy?.response
            log({ proof: custom, answer: res?.status, error: res?.data?.data ?? e?.message })
          }
        }
        await prove({ status: 'pending' })
        if (report.data.custom?.account === 'fail') return prove({ status: 'rejected', reason: 'bridge.report-failed', detail: 'No such account' })
        const dir = `ledgers/${LEDGER}/schemas/${report.data.schema}/reports/${report.luid}/assets`
        await prove({
          status: 'completed',
          assets: [
            { handle: 'report.csv', output: `gs://open-ledger-conformance/${dir}/report.csv` },
            { handle: 'web.csv', output: `${BASE_URL}/files/web.csv` },
          ],
        })
      },
    },
  ],
  hooks: () => 202,
})

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? BASE)!, ledger: LEDGER, secure })
// Off the record: until the report reaches a final status (or 30 s pass).
async function settled(handle: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const r: any = (await poller.report.read(handle)).response.data
      if (['completed', 'rejected'].includes(r.meta.status)) return r.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
const signed = (b: any) => b.hash().sign([{ keyPair }]).send()
const report = (name: string, data: Record<string, unknown>) => step(`report.create ${name}`, () => signed(s.report.init().data({ access: mine, ...data })))
const schema = (handle: string, custom: Record<string, unknown>, record = 'report') =>
  step(`schema.create ${handle}`, () =>
    signed(
      s.schema.init().data({
        handle,
        record,
        format: 'json-schema',
        schema: { title: handle, type: 'object', required: ['custom'], properties: { custom: { type: 'object', additionalProperties: false, ...custom } } },
        access: mine,
      }),
    ),
  )
const prove = (name: string, handle: string, custom: Record<string, unknown>) =>
  step(`report.sign ${name}`, async () => {
    const r = (await s.report.read(handle)).response.data
    return s.report.from(r).hash().sign([{ keyPair, custom: { moment: new Date().toISOString(), ...custom } }]).send()
  })

// A raw signed request, for what the SDK has no call for (POST …/drop) or hides (downloads).
async function raw(name: string, method: string, path: string, body?: unknown) {
  const iat = Math.floor(Date.now() / 1000)
  const jwt = await signJWT({ iat, exp: iat + 300, iss: keyPair.public, aud: LEDGER, sub: `signer:${keyPair.public}` }, keyPair.secret, keyPair.public)
  return step(name, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, 'x-ledger': LEDGER, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    console.log(`      ${res.status} ${res.headers.get('content-type') ?? ''} ${res.headers.get('content-disposition') ?? ''} ${text.slice(0, 120).replace(/\n/g, '\\n')}`)
  })
}

// Before any report schema: is a report without one accepted?
await report('without schema, none defined', { handle: 'r0', custom: { a: 1 } })

await step('bridge.create rep', () =>
  signed(s.bridge.init().data({ handle: 'rep', schema: 'rest', config: { server: `${BASE_URL}/v2` }, secure: [], traits: ['effects'], access: mine })),
)
// The docs' warning names a `reports` trait.
await step('bridge.create reports trait', () =>
  signed(s.bridge.init().data({ handle: 'rep2', schema: 'rest', config: { server: `${BASE_URL}/v2` }, secure: [], traits: ['reports'], access: mine })),
)
await schema('test-report', { required: ['account'], properties: { account: { title: 'Account', type: 'string' } } })
await schema('plain-report', { properties: { note: { type: 'string' } } })
await schema('wallet-kind', {}, 'wallet')
await step('effect.create report-created', () =>
  signed(
    s.effect.init().data({
      handle: 'test-report-created',
      signal: 'report-created',
      filter: { 'report.data.schema': 'test-report' },
      action: { schema: 'bridge', bridge: 'rep' },
      access: mine,
    }),
  ),
)
await step('effect.create report-proofs-added', () =>
  signed(s.effect.init().data({ handle: 'report-proofs', signal: 'report-proofs-added', action: { schema: 'webhook', endpoint: `${BASE_URL}/hooks/proofs` }, access: mine })),
)

await report('without schema', { handle: 'r-none', custom: { account: '1' } })
await report('unknown schema', { handle: 'r-ghost', schema: 'ghost-report', custom: { account: '1' } })
await report('schema of another record', { handle: 'r-wallet', schema: 'wallet-kind', custom: { account: '1' } })
await report('missing parameter', { handle: 'r-bad', schema: 'test-report', custom: {} })
await report('extra parameter', { handle: 'r-extra', schema: 'test-report', custom: { account: '1', other: 2 } })

// The protocol, end to end.
await report('r1', { handle: 'r1', schema: 'test-report', custom: { account: '1001001001' } })
console.log(`      settled: ${await settled('r1')}`)
await report('duplicate', { handle: 'r1', schema: 'test-report', custom: { account: '1001001001' } })
await report('r-fail', { handle: 'r-fail', schema: 'test-report', custom: { account: 'fail' } })
console.log(`      settled: ${await settled('r-fail')}`)
// No effect for this schema: nothing is called and the report stays `created`.
await report('r2', { handle: 'r2', schema: 'plain-report', custom: { note: 'x' } })
await new Promise((r) => setTimeout(r, 3000))

await step('report.read r1', () => s.report.read('r1'))
await step('report.read r-fail', () => s.report.read('r-fail'))
await step('report.read r2', () => s.report.read('r2'))
await step('report.list', () => s.report.list())
await step('report.list completed', () => s.report.list({ 'meta.status': 'completed' }))
await step('report.list by schema', () => s.report.list({ 'data.schema': 'plain-report' }))

await raw('asset gs', 'GET', '/reports/r1/assets/report.csv')
await raw('asset https', 'GET', '/reports/r1/assets/web.csv')
await raw('asset unknown', 'GET', '/reports/r1/assets/nope.csv')
await raw('asset of a report without assets', 'GET', '/reports/r2/assets/report.csv')

// Status proofs by a client: any status, after `completed` too, and one not in the enum.
await prove('r2 pending', 'r2', { status: 'pending' })
await prove('r2 completed with assets', 'r2', { status: 'completed', assets: [{ handle: 'a.csv', output: 'gs://b/a.csv' }] })
await prove('r2 settled', 'r2', { status: 'settled' })
await prove('r2 unknown status', 'r2', { status: 'bogus' })
await prove('r1 pending after completed', 'r1', { status: 'pending' })
await prove('r1 without status', 'r1', { note: 'seen' })
await step('report.read r2 after proofs', () => s.report.read('r2'))
await step('report.read r1 after proofs', () => s.report.read('r1'))

await step('report.access check', () => s.report.with('r1').access.check({ data: { action: 'read' } }).hash().sign([{ keyPair }]).send())
await step('report.changes', () => s.report.with('r1').change.list())
await step('report.change 1', () => s.report.with('r1').change.read(1))
await step('report.change 3', () => s.report.with('r1').change.read(3))

// Drop by DELETE (SDK) and by POST …/drop.
await step('report.drop r2', () => signed(s.report.drop('r2')))
await step('report.read dropped', () => s.report.read('r2'))
const dropBody = await s.report.drop('r-fail').hash().sign([{ keyPair }]).read().catch(() => undefined)
if (dropBody) await raw('report.drop r-fail by POST', 'POST', '/reports/r-fail/drop', dropBody)
await step('report.read r-fail dropped', () => s.report.read('r-fail'))

await new Promise((r) => setTimeout(r, 3000))
await step('events.list report-proofs', () => s.effect.with('report-proofs').events.list({ page: { index: 0, limit: 50 } }))
await step('events.list test-report-created', () => s.effect.with('test-report-created').events.list({ page: { index: 0, limit: 50 } }))
await bridges.close()
