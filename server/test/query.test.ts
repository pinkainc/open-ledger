// List filters (about-queries) and the server surface the CLI needs before any
// create: server info, system schemas, filtered lists.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { matches, parseQuery } from '../src/query.js'
import { STORES, newKeyPair, ref, newLedger, sendIntent, settle, setupBooks, startServer, type KeyPair } from './helpers.js'

const intent = {
  data: {
    handle: 'acme',
    claims: [
      { action: 'transfer', source: 'svgs:5512@example.com', target: 'bob', symbol: 'usd', amount: 10 },
      { action: 'issue', target: { handle: 'carol' }, symbol: { handle: 'eur' }, amount: 50 },
    ],
  },
  meta: { status: 'completed', moment: '2026-09-26T10:00:00.000Z' },
}
const q = (query: Record<string, unknown>) => matches(intent, parseQuery(query))

describe('query filters', () => {
  test('equality, with and without $eq', () => {
    assert.ok(q({ 'data.handle': 'acme' }))
    assert.ok(q({ 'data.handle.$eq': 'acme' }))
    assert.ok(!q({ 'data.handle': 'other' }))
    assert.ok(q({ 'meta.status.$ne': 'pending' }))
  })

  test('$in and $nin, as the SDK encodes arrays', () => {
    assert.ok(q({ 'meta.status.$in[0]': 'pending', 'meta.status.$in[1]': 'completed' }))
    assert.ok(q({ 'meta.status.$in': ['pending', 'completed'] }))
    assert.ok(!q({ 'meta.status.$nin[0]': 'completed' }))
  })

  test('comparisons take the field type: numbers and ISO moments', () => {
    assert.ok(q({ 'data.claims.amount.$gt': '20' }), 'any claim above 20')
    assert.ok(!q({ 'data.claims.0.amount.$gt': '20' }), 'the first claim is 10')
    assert.ok(q({ 'data.claims.0.amount.$lte': '10' }))
    assert.ok(!q({ 'data.claims.amount.$gt': '9' , 'data.claims.amount.$lt': '10' }))
    assert.ok(q({ 'meta.moment.$gte': '2026-09-26T00:00:00.000Z' }))
  })

  test('any element of an array, and $regex', () => {
    assert.ok(q({ 'data.claims.action': 'issue' }))
    assert.ok(q({ 'data.claims.target.handle': 'carol' }))
    assert.ok(q({ 'data.handle.$regex': '^ac' }))
    assert.ok(!q({ 'data.claims.action': 'destroy' }))
  })

  test('$plainTextQuery matches whole words and address parts', () => {
    for (const t of ['acme', 'ACME', '5512@example.com', '5512', 'example.com', 'transfer', 'eur', 'carol']) assert.ok(q({ $plainTextQuery: t }), t)
    for (const t of ['acm', '551', 'example']) assert.ok(!q({ $plainTextQuery: t }), t)
  })

  test('paging parameters are not filters', () => {
    assert.ok(q({ 'page.index': '0', 'page.limit': '10' }))
  })
})

for (const [storeName, makeStore] of STORES) {
  describe(`server surface for the CLI on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let kp: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      kp = await newKeyPair()
    })
    after(() => server.close())

    test('GET /api/v2 describes the server, unsigned', async () => {
      const body: any = await (await fetch(server.base)).json()
      assert.deepEqual(Object.keys(body.data), ['handle', 'server', 'semver', 'status'])
      assert.equal(body.data.status, 'UP')
      assert.equal(body.data.server, server.base)
      assert.deepEqual(Object.keys(body.meta), ['moment'])
    })

    test('a ledger is created without a token when its proofs sign it', async () => {
      const k = await newKeyPair()
      const { handle } = await newLedger(server.base, k)
      const res = await fetch(`${server.base}/ledger`, { headers: { 'x-ledger': handle } })
      assert.equal(res.status, 200)
    })

    test('every ledger has the twelve system schemas; lists filter by data.record', async () => {
      const { handle } = await newLedger(server.base, kp)
      const get = async (path: string) => (await (await fetch(`${server.base}${path}`, { headers: { 'x-ledger': handle } })).json()) as any
      const all = await get('/schemas')
      assert.deepEqual(all.data.map((r: any) => r.data.handle).slice(0, 3), ['status', 'layout', 'access'])
      assert.equal(all.data.length, 12)
      assert.ok(all.data.every((r: any) => r.luid.startsWith('$sch.') && r.meta.proofs.length === 2))
      assert.deepEqual((await get('/schemas?data.record=bridge')).data.map((r: any) => r.data.handle), ['rest'])
      assert.deepEqual((await get('/schemas?data.record=symbol')).data, [])
      const policies = await get('/policies?data.record.%24in%5B0%5D=any&data.record.%24in%5B1%5D=intent')
      assert.deepEqual(policies.data.map((r: any) => r.data.handle), ['intent:status'])
    })

    test('the SDK filters intents by status', async () => {
      const { sdk } = await newLedger(server.base, kp, undefined, { 'intent.expiryThresholdMinutes': 60 })
      await setupBooks(sdk, kp, ['alice'])
      await sendIntent(sdk, kp, [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 5 }], 'i-1')
      await sendIntent(sdk, kp, [{ action: 'transfer', source: ref('alice'), target: ref('nobody'), symbol: ref('usd'), amount: 5 }], 'i-2')
      await settle(sdk, 'i-1')
      await settle(sdk, 'i-2')
      const { intents } = await (sdk.intent as any).list({ 'meta.status.$in': ['completed'] })
      assert.deepEqual(intents.map((i: any) => i.handle), ['i-1'])
    })
  })
}
