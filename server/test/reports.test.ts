// Reports (recorded in `reports`, `reports2`): a `$rep` record typed by a report schema,
// `report-created` to a reporting bridge through an effect, status proofs along a fixed
// table, assets on `completed`, and their download from the configured directory.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signJWT } from '@minka/ledger-sdk/crypto'
import { Core } from '../src/core.js'
import { REPORT_STATUSES, checkAssets, statusChange } from '../src/reports.js'
import { STORES, failure, newKeyPair, newLedger, startServer, testBridge, until, type KeyPair } from './helpers.js'

const BUCKET = 'reports-test'

describe('report status table and assets', () => {
  test('every pair: staying is a no-op, the recorded moves pass, the rest are refused', () => {
    const allowed = new Set(['created>pending', 'created>rejected', 'pending>completed', 'pending>rejected', 'completed>settled', 'rejected>pending', 'rejected>completed'])
    for (const from of REPORT_STATUSES)
      for (const to of REPORT_STATUSES) {
        if (from === to) assert.equal(statusChange(from, to), false)
        else if (allowed.has(`${from}>${to}`)) assert.equal(statusChange(from, to), true)
        else assert.throws(() => statusChange(from, to), { reason: 'record.update-rejected', message: `Proof contains invalid status change, from ${from} to ${to}` })
      }
  })

  test('an asset names the bucket, the documented path, and its own handle as the file', () => {
    const path = (file: string, domain = '') => `gs://${BUCKET}/ledgers/l${domain}/schemas/s/reports/$rep.-abc/assets/${file}`
    checkAssets([{ handle: 'a.csv', output: path('a.csv') }, { handle: 'b.csv', output: path('b.csv', '/domains/eu') }], BUCKET)
    checkAssets([], BUCKET)
    checkAssets([{ handle: 'a.csv', output: path('a.csv').replace(BUCKET, 'any') }], undefined)
    const refused = (assets: unknown, detail: RegExp) => assert.throws(() => checkAssets(assets, BUCKET), (e: any) => e.status === 422 && e.reason === 'record.invalid' && detail.test(e.message))
    refused([{ handle: 'a.csv', output: path('a.csv').replace(BUCKET, 'other') }], /bucket \(other\) different than reporting bucket \(reports-test\)/)
    refused([{ handle: 'a.csv', output: `gs://${BUCKET}/elsewhere/a.csv` }], /^Invalid gs URL/)
    refused([{ handle: 'a.csv', output: 'https://example.com/a.csv' }], /^Invalid gs URL/)
    refused([{ handle: 'a.csv', output: path('b.csv') }], /filename \(b\.csv\) different than asset handle \(a\.csv\)/)
    refused([{ output: path('a.csv') }], /asset handle \(undefined\)/)
  })
})

for (const [storeName, makeStore] of STORES) {
  describe(`reports on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let keyPair: KeyPair
    let bridge: Awaited<ReturnType<typeof testBridge>>
    const dir = mkdtempSync(join(tmpdir(), 'open-ledger-reports-'))
    before(async () => {
      const store = await makeStore()
      server = await startServer(store, new Core(store, { bridges: { retryMs: 5 } }), { reports: { bucket: BUCKET, dir } })
      keyPair = await newKeyPair()
      bridge = await testBridge()
    })
    after(async () => {
      await bridge.close()
      await server.close()
    })
    const sign = () => [{ keyPair }]
    const token = async (ledger: string) => {
      const iat = Math.floor(Date.now() / 1000)
      return signJWT({ iat, exp: iat + 300, iss: keyPair.public, aud: ledger, sub: `signer:${keyPair.public}` }, keyPair.secret, keyPair.public)
    }

    async function books() {
      const { sdk, handle } = await newLedger(server.base, keyPair)
      const s: any = sdk
      await s.schema
        .init()
        .data({ handle: 'acct', record: 'report', format: 'json-schema', schema: { type: 'object', required: ['custom'], properties: { custom: { type: 'object', required: ['account'], properties: { account: { type: 'string' } } } } } })
        .hash()
        .sign(sign())
        .send()
      return { s, ledger: handle }
    }
    const report = (s: any, handle: string, custom: Record<string, unknown> = { account: '1' }, schema = 'acct') =>
      s.report.init().data({ handle, schema, custom }).hash().sign(sign()).send()
    const prove = async (s: any, handle: string, custom: Record<string, unknown>) => {
      const r = (await s.report.read(handle)).response.data
      return (await s.report.from(r).hash().sign([{ keyPair, custom }]).send()).response.data
    }
    const read = async (s: any, handle: string) => (await s.report.read(handle)).response.data
    const output = (ledger: string, r: any, file: string) => `gs://${BUCKET}/ledgers/${ledger}/schemas/${r.data.schema}/reports/${r.luid}/assets/${file}`

    test('records: schema required and checked, custom validated, duplicate refused, created with a system proof', async () => {
      const { s } = await books()
      const noSchema = await failure(s.report.init().data({ handle: 'x', custom: {} }).hash().sign(sign()).send())
      assert.deepEqual([noSchema.reason, noSchema.detail], ['record.schema-invalid', "Schema validation error: request/body/data must have required property 'schema'"])
      await s.schema.init().data({ handle: 'w', record: 'wallet', format: 'json-schema', schema: { type: 'object' } }).hash().sign(sign()).send()
      for (const schema of ['ghost', 'w'])
        assert.deepEqual(
          Object.values(await failure(report(s, 'x', { account: '1' }, schema))).slice(1, 3),
          ['record.relation-not-found', `Schema ${schema} not found for record of type report.`],
        )
      assert.equal((await failure(report(s, 'x', {}))).detail, "Schema validator error: data.custom must have required property 'account'")
      const r = (await report(s, 'r1')).response.data
      assert.match(r.luid, /^\$rep\./)
      assert.equal(r.meta.status, 'created')
      assert.deepEqual(r.meta.proofs.at(-1).custom, { luid: r.luid, moment: r.meta.proofs.at(-1).custom.moment, status: 'created' })
      assert.deepEqual([(await failure(report(s, 'r1'))).status, (await failure(report(s, 'r1'))).detail], [409, 'Report with handle r1 already exists.'])
    })

    test('protocol: report-created reaches the reporting bridge; pending, then completed sets the assets', async () => {
      const { s, ledger } = await books()
      await s.bridge.init().data({ handle: 'rep', schema: 'rest', config: { server: bridge.url }, secure: [], traits: ['effects'] }).hash().sign(sign()).send()
      await s.effect
        .init()
        .data({ handle: 'made', signal: 'report-created', filter: { 'report.data.schema': 'acct' }, action: { schema: 'bridge', bridge: 'rep' } })
        .hash()
        .sign(sign())
        .send()
      await report(s, `p-${ledger}`)
      const call = await until(() => bridge.calls.find((c) => c.url === '/v2/effects/made' && c.body?.data?.report?.data?.handle === `p-${ledger}`), 'report-created call')
      assert.deepEqual(Object.keys(call.body.data).sort(), ['handle', 'report', 'signal'])
      assert.equal(call.body.data.signal, 'report-created')
      const sent = call.body.data.report
      assert.equal(sent.meta.status, 'created')

      assert.equal((await prove(s, sent.data.handle, { status: 'pending' })).meta.status, 'pending')
      const assets = [{ handle: 'out.csv', output: output(ledger, sent, 'out.csv') }]
      const done = await prove(s, sent.data.handle, { status: 'completed', assets })
      assert.deepEqual([done.meta.status, done.meta.assets], ['completed', assets])
      assert.deepEqual(done.data, sent.data, 'data and hash never change')
      assert.equal(done.hash, sent.hash)
    })

    test('a status proof repeating the current one is dropped: no proof, no change, no event', async () => {
      const { s } = await books()
      await s.effect.init().data({ handle: 'seen', signal: 'report-proofs-added', action: { schema: 'webhook', endpoint: `${bridge.url}/hooks/seen` } }).hash().sign(sign()).send()
      await report(s, 'r')
      await prove(s, 'r', { status: 'pending' })
      const before = await read(s, 'r')
      const again = await prove(s, 'r', { status: 'pending' })
      assert.deepEqual(again.meta.proofs, before.meta.proofs)
      assert.equal((await s.report.with('r').change.list()).response.data.data.length, 2)
      const events = async () => (await s.effect.with('seen').events.list()).response.data.data
      // created (the ledger's proof) and pending: two events, none for the repeat.
      const raised = await until(async () => ((await events()).length >= 2 ? await events() : undefined), 'proofs-added events')
      await new Promise((r) => setTimeout(r, 100))
      assert.equal((await events()).length, raised.length)
      assert.equal(raised.length, 2)
      const refused = await failure(prove(s, 'r', { status: 'settled' }))
      assert.deepEqual([refused.reason, refused.detail], ['record.update-rejected', 'Proof contains invalid status change, from pending to settled'])
      const unknown = await failure(prove(s, 'r', { status: 'bogus' }))
      assert.equal(unknown.detail, 'Schema validation error: request/body/custom/status must be equal to one of the allowed values: created, pending, completed, rejected, settled')
      assert.equal((await read(s, 'r')).meta.proofs.length, before.meta.proofs.length)
    })

    test('assets: refused on completed, not stored; kept only from a completed proof; an empty list is kept', async () => {
      const { s, ledger } = await books()
      await report(s, 'a')
      await prove(s, 'a', { status: 'pending', assets: [{ handle: 'x', output: 'anything' }] })
      assert.equal((await read(s, 'a')).meta.assets, undefined, 'assets on pending are only part of the proof')
      const r = await read(s, 'a')
      const bad = await failure(prove(s, 'a', { status: 'completed', assets: [{ handle: 'a.csv', output: output(ledger, r, 'a.csv').replace(BUCKET, 'elsewhere') }] }))
      assert.deepEqual([bad.status, bad.reason], [422, 'record.invalid'])
      assert.equal((await read(s, 'a')).meta.status, 'pending')
      assert.deepEqual((await prove(s, 'a', { status: 'completed', assets: [] })).meta.assets, [])
      await report(s, 'b')
      await prove(s, 'b', { status: 'pending' })
      assert.equal((await prove(s, 'b', { status: 'completed' })).meta.assets, undefined)
    })

    test('download: the file under the reports directory as an attachment; unknown or absent assets are 404', async () => {
      const { s, ledger } = await books()
      await report(s, 'd')
      await prove(s, 'd', { status: 'pending' })
      const r = await read(s, 'd')
      const stored = output(ledger, r, 'data.csv')
      await prove(s, 'd', { status: 'completed', assets: [{ handle: 'data.csv', output: stored }, { handle: 'gone.csv', output: output(ledger, r, 'gone.csv') }] })
      const file = join(dir, stored.replace(`gs://${BUCKET}/`, ''))
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'a,b\n1,2\n')

      const target = join(dir, 'downloaded.csv')
      const got = await s.report.downloadAsset('d', 'data.csv', target)
      assert.equal(got.originalFilename, 'data.csv')
      const raw = async (asset: string, id = 'd') => {
        const jwt = await token(ledger)
        return fetch(`${server.base}/reports/${encodeURIComponent(id)}/assets/${asset}`, { headers: { authorization: `Bearer ${jwt}`, 'x-ledger': ledger } })
      }
      const ok = await raw('data.csv', r.luid)
      assert.deepEqual([ok.status, ok.headers.get('content-disposition'), await ok.text()], [200, 'attachment; filename="data.csv"', 'a,b\n1,2\n'])
      const missing = await raw('gone.csv')
      assert.deepEqual([missing.status, (await missing.json()).data.detail], [404, 'Asset gone.csv is not stored on this server'])
      const unknown = await raw('nope.csv')
      assert.deepEqual([unknown.status, (await unknown.json()).data.detail], [404, 'Asset nope.csv not found'])
      assert.equal((await raw('data.csv', 'ghost')).status, 404)
    })

    test('drop by DELETE and by POST …/drop; a dropped report is gone', async () => {
      const { s, ledger } = await books()
      await report(s, 'x1')
      await report(s, 'x2')
      await s.report.drop('x1').hash().sign(sign()).send()
      assert.equal((await failure(s.report.read('x1'))).detail, 'Report not found')
      const body = await s.report.drop('x2').hash().sign(sign()).read()
      const jwt = await token(ledger)
      const res = await fetch(`${server.base}/reports/x2/drop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-ledger': ledger, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(res.status, 204)
      assert.equal((await failure(s.report.read('x2'))).status, 404)
    })
  })
}
