// L8: bridge event deliveries (recorded in `events`). Every call to a bridge is a
// delivery with a signed proof per attempt; 501 cancels it and notes the intent; a
// retry by handle sends it again whatever its status.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Core } from '../src/core.js'
import { STORES, failure, newKeyPair, newLedger, ref, sdkFor, settle, startServer, testBridge, until, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`event deliveries on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let bridge: Awaited<ReturnType<typeof testBridge>>
    let kp: KeyPair, bank: KeyPair
    before(async () => {
      const store = await makeStore()
      server = await startServer(store, new Core(store, { bridges: { retryMs: 20 } }))
      bridge = await testBridge()
      kp = await newKeyPair()
      bank = await newKeyPair()
    })
    after(async () => {
      await server.close()
      await bridge.close()
    })

    let seq = 0
    async function books() {
      const { handle, sdk } = await newLedger(server.base, kp)
      const s: any = sdk
      const sign = [{ keyPair: kp }]
      await s.bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: bridge.url }, secure: [] }).hash().sign(sign).send()
      await s.signer.init().data({ handle: 'bank', public: bank.public, format: 'ed25519-raw' }).hash().sign(sign).send()
      await s.symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign(sign).send()
      await s.wallet.init().data({ handle: 'alice' }).hash().sign(sign).send()
      await s.wallet.init().data({ handle: 'acc', bridge: 'bank' }).hash().sign(sign).send()
      await s.intent.init().data({ handle: `fund-${++seq}`, claims: [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 100 }] }).hash().sign(sign).send()
      return { ledger: handle, sdk: s, asBank: sdkFor(server.base, handle, bank) as any }
    }
    async function out(sdk: any, amount: number) {
      const handle = `e-${++seq}`
      await sdk.intent.init().data({ handle, claims: [{ action: 'transfer', source: ref('alice'), target: ref('acc'), symbol: ref('usd'), amount }] }).hash().sign([{ keyPair: kp }]).send()
      return handle
    }
    const deliveries = async (sdk: any, filter: Record<string, unknown> = {}) => (await sdk.bridge.with('bank').events.list(filter)).response.data.data
    const statuses = (d: any) => d.meta.proofs.map((p: any) => p.custom.status)

    test('a prepare answered 500 then 202: failed, delivered, two attempts, same handle', async () => {
      const { sdk } = await books()
      let n = 0
      bridge.answerWith((c) => (c.url === '/v2/credits' && n++ === 0 ? 500 : 202))
      try {
        const h = await out(sdk, 5)
        const d = await until(async () => (await deliveries(sdk, { 'data.linked': h })).find((d: any) => d.meta.status === 'delivered'), 'delivered prepare')
        assert.deepEqual([d.data.bridge, d.data.effect, d.data.record, d.data.linked], ['bank', null, 'intent', h])
        assert.match(d.luid, /^\$evd\./)
        assert.match(d.data.handle, /^[0-9A-Za-z]{17}$/)
        assert.deepEqual(statuses(d), ['failed', 'delivered'])
        assert.deepEqual(d.meta.proofs[0].custom, { detail: { httpStatus: 500 }, moment: d.meta.proofs[0].custom.moment, reason: 'delivery.target-rejected', status: 'failed' })
        assert.equal(d.meta.replay, 2)
        assert.equal(d.meta.output.data.schema, 'credit', 'the output is the prepare that was sent')
        assert.ok(d.meta.proofs.every((p: any) => p.signer === 'system'))
      } finally {
        bridge.answerWith(() => 202)
      }
    })

    test('501 cancels the delivery and notes the intent; a retry by handle completes it', async () => {
      const { sdk, asBank } = await books()
      let n = 0
      bridge.answerWith((c) => (c.url === '/v2/credits' && n++ === 0 ? 501 : 202))
      try {
        const h = await out(sdk, 3)
        const d = await until(async () => (await deliveries(sdk, { 'meta.status': 'cancelled' })).find((d: any) => d.data.linked === h), 'cancelled')
        assert.deepEqual(statuses(d), ['failed', 'cancelled'])
        assert.deepEqual(d.meta.proofs[0].custom.detail, { body: '{}', httpStatus: 501 })
        assert.equal(d.meta.proofs[1].custom.reason, 'delivery.permanent-failure')
        assert.equal(d.meta.replay, 1)
        const waiting = (await sdk.intent.read(h)).response.data
        assert.equal(waiting.meta.status, 'pending')
        const note = waiting.meta.proofs.at(-1)
        assert.deepEqual([note.signer, note.custom.status, note.custom.reason, note.custom.detail], ['system', 'error', 'core.bridge-unreachable', 'Request failed with status code 501'])

        const res = await sdk.bridge.with('bank').events.retry({ handle: d.data.handle }).hash().sign([{ keyPair: kp }]).send()
        assert.equal(res.response.status, 202)
        const prepare = await until(() => bridge.calls.filter((c) => c.url === '/v2/credits' && c.body.data.intent.data.handle === h)[1], 'prepare again')
        await asBank.intent.from(prepare.body.data.intent).sign([{ keyPair: bank, custom: { handle: prepare.body.data.handle, status: 'prepared' } }]).send()
        const commit = await until(() => bridge.calls.find((c) => c.url.endsWith('/commit') && c.body.data.intent.data.handle === h), 'commit')
        await asBank.intent.from(commit.body.data.intent).sign([{ keyPair: bank, custom: { handle: prepare.body.data.handle, status: 'committed' } }]).send()
        assert.equal((await settle(sdk, h)).meta.status, 'completed')
        const after = (await sdk.bridge.with('bank').events.find(d.data.handle)).response.data
        assert.deepEqual(statuses(after), ['failed', 'cancelled', 'delivered'])
        assert.equal(after.meta.replay, 2)
      } finally {
        bridge.answerWith(() => 202)
      }
    })

    test('unknown handles are 404; a retry by age answers 202', async () => {
      const { ledger, sdk } = await books()
      const find = await failure(sdk.bridge.with('bank').events.find('0000000000000nope'))
      assert.deepEqual([find.status, find.reason, find.detail], [404, 'record.not-found', `Event delivery '0000000000000nope' not found on ledger '${ledger}'`])
      const retry = await failure(sdk.bridge.with('bank').events.retry({ handle: '0000000000000nope' }).hash().sign([{ keyPair: kp }]).send())
      assert.deepEqual([retry.status, retry.detail], [404, `Event '0000000000000nope' not found on ledger '${ledger}'`])
      const bulk = await sdk.bridge.with('bank').events.retry({ maxAge: 60 }).hash().sign([{ keyPair: kp }]).send()
      assert.equal(bulk.response.status, 202)
    })

    test('lists are filtered and newest first', async () => {
      const { sdk } = await books()
      const h = await out(sdk, 1)
      await until(async () => (await deliveries(sdk, { 'data.linked': h })).length === 1, 'one delivery')
      const all = await deliveries(sdk)
      assert.equal(all[0].data.linked, h)
      assert.deepEqual(await deliveries(sdk, { 'meta.status.$in': ['cancelled'] }), [])
    })
  })
}
