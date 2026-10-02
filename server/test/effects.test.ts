// Effects (recorded in `effects`): a signal, a filter on the event, and a webhook or a
// bridge with the trait `effects` to call. Each call is a delivery like a bridge's.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Core } from '../src/core.js'
import { STORES, failure, newKeyPair, newLedger, ref, settle, startServer, testBridge, until, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`effects on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let target: Awaited<ReturnType<typeof testBridge>>
    let kp: KeyPair
    before(async () => {
      const store = await makeStore()
      server = await startServer(store, new Core(store, { bridges: { retryMs: 5 } }))
      target = await testBridge()
      kp = await newKeyPair()
    })
    after(async () => {
      await server.close()
      await target.close()
    })

    const sign = () => [{ keyPair: kp }]
    let seq = 0
    async function books() {
      const { sdk } = await newLedger(server.base, kp)
      const s: any = sdk
      await s.symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign(sign()).send()
      for (const w of ['alice', 'bob', 'carol']) await s.wallet.init().data({ handle: w }).hash().sign(sign()).send()
      await move(s, [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 100 }])
      return s
    }
    async function move(s: any, claims: unknown[]) {
      const handle = `i-${++seq}`
      await s.intent.init().data({ handle, claims }).hash().sign(sign()).send()
      assert.equal((await settle(s, handle)).meta.status, 'completed')
      return handle
    }
    const pay = (s: any, to: string, amount: number) => move(s, [{ action: 'transfer', source: ref('alice'), target: ref(to), symbol: ref('usd'), amount }])
    const effect = (s: any, data: Record<string, unknown>) => s.effect.init().data(data).hash().sign(sign()).send()
    const hook = (name: string) => ({ schema: 'webhook', endpoint: `${target.url.replace(/\/v2$/, '')}/hooks/${name}` })
    const events = async (s: any, e: string, filter: Record<string, unknown> = {}) => (await s.effect.with(e).events.list(filter)).response.data.data
    const final = (rows: any[]) => rows.length > 0 && rows.every((d: any) => ['delivered', 'cancelled'].includes(d.meta.status))
    const calls = (path: string) => target.calls.filter((c) => c.url === path)

    test('balance-received, filtered on the event: amount, wallet, symbol, the committed intent', async () => {
      const s = await books()
      await effect(s, { handle: 'got', signal: 'balance-received', filter: { 'wallet.data.handle': 'bob', 'symbol.data.handle': 'usd' }, action: hook('got') })
      const h = await pay(s, 'bob', 30)
      await pay(s, 'carol', 5)
      const [d] = await until(async () => {
        const rows = await events(s, 'got')
        return final(rows) && rows
      }, 'delivered event')
      assert.equal((await events(s, 'got')).length, 1, 'carol is filtered out')
      assert.deepEqual(d.data, { handle: d.data.handle, bridge: null, effect: 'got', record: 'wallet', linked: 'bob' })
      assert.deepEqual(d.meta.proofs.map((p: any) => p.custom.status), ['delivered'])
      const e = d.meta.output
      assert.match(e.data.handle, /^evt_[\w-]{17}$/)
      assert.deepEqual([e.data.signal, e.data.amount, e.data.wallet.data.handle, e.data.symbol.data.handle, e.data.intent.data.handle], ['balance-received', 30, 'bob', 'usd', h])
      assert.deepEqual([e.data.intent.meta.status, e.data.intent.meta.routed, e.data.intent.meta.proofs.length], ['committed', true, 9])
      assert.equal(e.meta.proofs[0].signer, 'system')
      const sent = calls('/hooks/got').find((c) => c.body.data.handle === e.data.handle)
      assert.deepEqual(sent?.body, e, 'the webhook gets the event as the delivery keeps it')
    })

    test('intent-updated: every version that moves the intent on, with the one before', async () => {
      const s = await books()
      const handle = `i-${seq + 1}`
      await effect(s, { handle: 'upd', signal: 'intent-updated', filter: { 'intent.data.handle': handle }, action: hook('upd') })
      await effect(s, { handle: 'new', signal: 'intent-created', action: hook('new') })
      await pay(s, 'bob', 1)
      const rows = await until(async () => {
        const r = await events(s, 'upd')
        return r.length === 4 && final(r) && r
      }, 'four events')
      const pairs = rows
        .map((d: any) => d.meta.output.data)
        .map((e: any) => [e.intent.meta.status, e.intent.meta.proofs.length, e.parent.meta.status, e.parent.meta.proofs.length])
        .sort((a: any, b: any) => a[1] - b[1])
      assert.deepEqual(pairs, [
        ['prepared', 8, 'pending', 5],
        ['committed', 9, 'prepared', 8],
        ['committed', 11, 'committed', 9],
        ['completed', 12, 'committed', 9],
      ])
      const [created] = await until(async () => {
        const r = await events(s, 'new', { 'data.linked': handle })
        return final(r) && r
      }, 'intent-created')
      assert.deepEqual([created.meta.output.data.intent.meta.status, created.meta.output.data.intent.meta.proofs.length], ['pending', 3])
    })

    test('one event for every effect it reaches; 501 cancels, a retry by handle delivers', async () => {
      const s = await books()
      let closed = true
      target.answerWith((c) => (c.url === '/hooks/closed' && closed ? 501 : 202))
      try {
        await effect(s, { handle: 'a', signal: 'wallet-created', action: hook('closed') })
        await effect(s, { handle: 'b', signal: 'wallet-created', action: hook('open') })
        await s.wallet.init().data({ handle: 'dave' }).hash().sign(sign()).send()
        const [a] = await until(async () => {
          const r = await events(s, 'a')
          return final(r) && r
        }, 'cancelled')
        const [b] = await until(async () => {
          const r = await events(s, 'b')
          return final(r) && r
        }, 'delivered')
        assert.equal(a.meta.output.data.handle, b.meta.output.data.handle)
        assert.deepEqual(a.meta.proofs.map((p: any) => p.custom.status), ['failed', 'cancelled'])
        assert.deepEqual(a.meta.proofs[0].custom.detail, { httpStatus: 501 }, 'no answer body on an effect delivery')
        assert.equal(a.meta.replay, 1)
        await failure(s.effect.with('b').events.find(a.data.handle))
        closed = false
        await s.effect.with('a').events.retry({ handle: a.data.handle }).hash().sign(sign()).send()
        const again = await until(async () => {
          const d = (await s.effect.with('a').events.find(a.data.handle)).response.data
          return d.meta.status === 'delivered' && d
        }, 'retried')
        assert.equal(again.meta.replay, 2)
      } finally {
        target.answerWith(() => 202)
      }
    })

    test('bridges: `effects` trait called at /effects/{effect}, other traits skipped, a missing bridge fails inside', async () => {
      const s = await books()
      const bridge = (handle: string, traits?: string[]) =>
        s.bridge.init().data({ handle, schema: 'rest', config: { server: `${target.url.replace(/\/v2$/, '')}/${handle}/v2` }, secure: [], ...(traits ? { traits } : {}) }).hash().sign(sign()).send()
      await bridge('fx', ['effects'])
      await bridge('deb', ['debits'])
      const refused = await failure(bridge('old', ['events']))
      assert.equal(refused.reason, 'record.schema-invalid')
      assert.match(refused.body.data.custom.errors[0].message, /^must be equal to one of the allowed values: debits, credits, statuses, anchors, domains, effects, ping$/)
      for (const [h, b] of [['to-fx', 'fx'], ['to-deb', 'deb'], ['to-none', 'nope']])
        await effect(s, { handle: h, signal: 'wallet-created', action: { schema: 'bridge', bridge: b } })
      await s.wallet.init().data({ handle: 'erin' }).hash().sign(sign()).send()
      const [fx] = await until(async () => {
        const r = await events(s, 'to-fx')
        return final(r) && r
      }, 'bridge effect')
      assert.deepEqual([fx.data.bridge, fx.data.record, fx.data.linked], ['fx', 'wallet', 'erin'])
      assert.ok(calls('/fx/v2/effects/to-fx').length >= 1)
      const [lost] = await until(async () => {
        const r = await events(s, 'to-none')
        return final(r) && r
      }, 'missing bridge', 10_000)
      assert.deepEqual([lost.data.bridge, lost.data.record, lost.data.linked, lost.meta.output], ['nope', null, null, null])
      assert.equal(lost.meta.proofs.length, 11)
      assert.deepEqual(lost.meta.proofs[0].custom.detail, { reason: 'core.unexpected-error', message: 'Bridge nope not found' })
      assert.deepEqual([lost.meta.status, lost.meta.proofs.at(-1).custom.reason, lost.meta.replay], ['cancelled', 'delivery.retry-cap-exhausted', 11])
      assert.deepEqual(await events(s, 'to-deb'), [], 'a bridge without the trait gets nothing')
    })

    test('records: validation, no filter by signal, update narrows, drop stops', async () => {
      const s = await books()
      const bad = await failure(effect(s, { handle: 'x', signal: 'nope', action: hook('x') }))
      assert.equal(bad.reason, 'record.schema-invalid')
      assert.match(bad.detail, /^Schema validation error: request\/body\/data\/signal must be equal to one of the allowed values: anchor-created, /)
      const noEndpoint = await failure(effect(s, { handle: 'x', signal: 'wallet-created', action: { schema: 'webhook' } }))
      assert.deepEqual(noEndpoint.body.data.custom.errors.map((e: any) => e.path), ['/body/data/action/endpoint', '/body/data/action/bridge', '/body/data/action'])
      const created = (await effect(s, { handle: 'r', signal: 'balance-received', filter: { 'wallet.data.handle': 'bob' }, action: hook('r') })).response.data
      assert.match(created.luid, /^\$eff\./)
      assert.equal((await failure(s.effect.list({ 'data.signal': 'balance-received' }))).reason, 'api.query-malformed')
      await s.effect.from(created).data({ ...created.data, parent: created.hash, filter: { 'wallet.data.handle': 'carol' } }).hash().sign(sign()).send()
      await pay(s, 'bob', 1)
      await s.effect.drop('r').hash().sign(sign()).send()
      assert.equal((await failure(s.effect.read('r'))).status, 404)
      await pay(s, 'carol', 1)
      assert.equal(calls('/hooks/r').length, 0, 'bob no longer matches, and carol came after the drop')
    })
  })
}
