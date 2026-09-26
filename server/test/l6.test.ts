// L6: several participants in one intent (recorded in l6). Prepare runs in two phases —
// debits, then credits once every debit is prepared; only parts asked to prepare are
// aborted and notified; bridges may group their entries (`claims.groupBy`).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Core } from '../src/core.js'
import { STORES, balanceOf, newKeyPair, newLedger, ref, sdkFor, settle, startServer, testBridge, until, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`L6 several bridges on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let b1: Awaited<ReturnType<typeof testBridge>>, b2: Awaited<ReturnType<typeof testBridge>>
    let kp: KeyPair, k1: KeyPair, k2: KeyPair
    before(async () => {
      const store = await makeStore()
      server = await startServer(store, new Core(store, { minuteMs: 100, bridges: { retryMs: 20 } }))
      b1 = await testBridge()
      b2 = await testBridge()
      kp = await newKeyPair()
      k1 = await newKeyPair()
      k2 = await newKeyPair()
    })
    after(async () => {
      await server.close()
      await b1.close()
      await b2.close()
    })

    const raw = async (p: Promise<any>) => (await p).response.data
    let seq = 0

    // alice is native; a1, a1b belong to bank1; b2, b2b to bank2 (grouping when asked).
    async function books(bank2Config: Record<string, unknown> = {}, config?: Record<string, unknown>) {
      const { handle, sdk } = await newLedger(server.base, kp, [{ action: 'any', record: 'any' }], config)
      const s: any = sdk
      const sign = [{ keyPair: kp }]
      await s.bridge.init().data({ handle: 'bank1', schema: 'rest', config: { server: b1.url }, secure: [] }).hash().sign(sign).send()
      await s.bridge.init().data({ handle: 'bank2', schema: 'rest', config: { server: b2.url, ...bank2Config }, secure: [] }).hash().sign(sign).send()
      await s.signer.init().data({ handle: 'bank1', public: k1.public, format: 'ed25519-raw' }).hash().sign(sign).send()
      await s.signer.init().data({ handle: 'bank2', public: k2.public, format: 'ed25519-raw' }).hash().sign(sign).send()
      await s.symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign(sign).send()
      for (const [w, bridge] of [['alice'], ['a1', 'bank1'], ['a1b', 'bank1'], ['b2', 'bank2'], ['b2b', 'bank2']])
        await s.wallet.init().data({ handle: w, ...(bridge ? { bridge } : {}) }).hash().sign(sign).send()
      const h = await send(s, ['alice', 'a1', 'a1b', 'b2', 'b2b'].map((w) => ({ action: 'issue', target: ref(w), symbol: ref('usd'), amount: 100 })))
      await settle(s, h)
      return { ledger: handle, sdk: s, as1: sdkFor(server.base, handle, k1) as any, as2: sdkFor(server.base, handle, k2) as any }
    }

    async function send(sdk: any, claims: unknown[]) {
      const handle = `m-${++seq}`
      await sdk.intent.init().data({ handle, claims }).hash().sign([{ keyPair: kp }]).send()
      return handle
    }
    const t = (from: string, to: string, amount: number) => ({ action: 'transfer', source: ref(from), target: ref(to), symbol: ref('usd'), amount })
    const of = (bridge: typeof b1, intent: string) => bridge.calls.filter((c) => (c.body?.data?.intent?.data?.handle ?? c.body?.data?.handle) === intent)
    const prepares = (bridge: typeof b1, intent: string) => of(bridge, intent).filter((c) => /\/(debits|credits)$/.test(c.url))
    const report = (as: any, key: KeyPair, intent: any, custom: Record<string, unknown>) => raw(as.intent.from(intent).sign([{ keyPair: key, custom }]).send())
    const quiet = () => new Promise((r) => setTimeout(r, 150))

    test('credits are prepared only once every debit is prepared, with the current intent', async () => {
      const { sdk, as1, as2 } = await books()
      const h = await send(sdk, [t('a1', 'b2', 20)])
      const debit = await until(() => prepares(b1, h)[0], 'debit prepare')
      await quiet()
      assert.equal(prepares(b2, h).length, 0, 'no credit before the debit is prepared')
      assert.equal(debit.body.data.intent.meta.domains, undefined)

      await report(as1, k1, debit.body.data.intent, { handle: debit.body.data.handle, status: 'prepared' })
      const credit = await until(() => prepares(b2, h)[0], 'credit prepare')
      const intent = credit.body.data.intent
      assert.deepEqual(intent.meta.domains, [])
      assert.ok(intent.meta.proofs.some((p: any) => p.signer === 'bank1' && p.custom.status === 'prepared'), 'the credit carries the debit report')

      await report(as2, k2, intent, { handle: credit.body.data.handle, status: 'prepared' })
      const c1 = await until(() => of(b1, h).find((c) => c.url.endsWith('/commit')), 'commit to bank1')
      const c2 = await until(() => of(b2, h).find((c) => c.url.endsWith('/commit')), 'commit to bank2')
      await report(as1, k1, c1.body.data.intent, { handle: debit.body.data.handle, status: 'committed' })
      await report(as2, k2, c2.body.data.intent, { handle: credit.body.data.handle, status: 'committed' })
      assert.equal((await settle(sdk, h)).meta.status, 'completed')
      assert.deepEqual(await balanceOf(sdk, 'a1'), { available: 80, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'b2'), { available: 120, reserved: 0 })
    })

    test('a failed debit: the credit is never prepared, aborted or told', async () => {
      const { sdk, as1 } = await books()
      const h = await send(sdk, [t('a1', 'b2', 8)])
      const debit = await until(() => prepares(b1, h)[0], 'debit prepare')
      await report(as1, k1, debit.body.data.intent, { handle: debit.body.data.handle, status: 'failed', reason: 'bridge.unexpected-error', detail: 'frozen' })
      const abort = await until(() => of(b1, h).find((c) => c.url.endsWith('/abort')), 'abort to bank1')
      await report(as1, k1, abort.body.data.intent, { handle: debit.body.data.handle, status: 'aborted' })
      const done = await settle(sdk, h)
      assert.equal(done.meta.status, 'rejected')
      assert.ok(done.meta.proofs.some((p: any) => p.custom.reason === 'core.bridge-prepare-failed' && p.custom.detail === 'Bridge(s) failed to process intent: bank1'))
      await until(() => of(b1, h).find((c) => c.method === 'PUT'), 'status to bank1')
      await quiet()
      assert.deepEqual(of(b2, h), [], 'bank2 heard nothing')
      assert.deepEqual(await balanceOf(sdk, 'a1'), { available: 100, reserved: 0 })
    })

    test('a failed credit after a prepared debit: both are aborted', async () => {
      const { sdk, as1, as2 } = await books()
      const h = await send(sdk, [t('a1', 'alice', 4), t('alice', 'b2', 9)])
      const debit = await until(() => prepares(b1, h)[0], 'debit prepare')
      await report(as1, k1, debit.body.data.intent, { handle: debit.body.data.handle, status: 'prepared' })
      const credit = await until(() => prepares(b2, h)[0], 'credit prepare')
      await report(as2, k2, credit.body.data.intent, { handle: credit.body.data.handle, status: 'failed', reason: 'bridge.unexpected-error', detail: 'closed' })
      const a1 = await until(() => of(b1, h).find((c) => c.url.endsWith('/abort')), 'abort to bank1')
      const a2 = await until(() => of(b2, h).find((c) => c.url.endsWith('/abort')), 'abort to bank2')
      await report(as1, k1, a1.body.data.intent, { handle: debit.body.data.handle, status: 'aborted' })
      await report(as2, k2, a2.body.data.intent, { handle: credit.body.data.handle, status: 'aborted' })
      assert.equal((await settle(sdk, h)).meta.status, 'rejected')
      assert.deepEqual(await balanceOf(sdk, 'a1'), { available: 100, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
    })

    test('grouping: one call per address or wallet, summed, with a handle of its own', async () => {
      const { sdk, as2 } = await books({ 'debits.claims.groupBy': 'address', 'credits.claims.groupBy': 'wallet' })
      const h = await send(sdk, [t('alice', 'b2', 3), t('alice', 'b2', 4), t('b2', 'alice', 2), t('b2', 'b2b', 1)])
      const debit = await until(() => prepares(b2, h)[0], 'grouped debit')
      const d = debit.body.data
      assert.deepEqual([d.schema, d.amount, d.inputs, d.source, d.target], ['debit', 3, [2, 3], { handle: 'b2' }, null])
      const resolved = (await raw(sdk.intent.read(h))).meta.proofs.filter((p: any) => p.custom.status === 'resolved').map((p: any) => p.custom.handle)
      assert.equal(resolved.length, 8, 'resolution stays per claim')
      assert.ok(!resolved.includes(d.handle))
      await report(as2, k2, d.intent, { handle: d.handle, status: 'prepared' })

      await until(() => prepares(b2, h).length === 3, 'credits')
      const credits = prepares(b2, h).slice(1).map((c) => c.body.data)
      const group = credits.find((c) => c.inputs.length === 2)!
      const single = credits.find((c) => c.inputs.length === 1)!
      assert.deepEqual([group.amount, group.inputs, group.source, group.target], [7, [0, 1], null, { handle: 'b2' }])
      assert.ok(resolved.includes(single.handle), 'a group of one keeps its entry handle')
      assert.deepEqual([single.source, single.target], [{ handle: 'b2' }, { handle: 'b2b' }])
      for (const c of credits) await report(as2, k2, c.intent, { handle: c.handle, status: 'prepared' })

      await until(() => of(b2, h).filter((c) => c.url.endsWith('/commit')).length === 3, 'three commits')
      const commits = of(b2, h).filter((c) => c.url.endsWith('/commit'))
      assert.ok(commits.some((c) => c.url === `/v2/debits/${d.handle}/commit`))
      for (const c of commits) await report(as2, k2, c.body.data.intent, { handle: c.body.data.handle, status: 'committed' })
      assert.equal((await settle(sdk, h)).meta.status, 'completed')
      assert.deepEqual(await balanceOf(sdk, 'b2'), { available: 104, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'b2b'), { available: 101, reserved: 0 })
    })

    test('credits go out once, however many passes follow the last debit report', async () => {
      const { ledger, sdk, as1 } = await books()
      const h = await send(sdk, [t('a1', 'a1b', 1), t('a1b', 'a1', 2)])
      await until(() => prepares(b1, h).length === 2, 'two debit prepares')
      const debits = prepares(b1, h).map((c) => c.body.data)
      assert.ok(debits.every((d) => d.schema === 'debit'))
      await Promise.all(debits.map((d) => report(as1, k1, d.intent, { handle: d.handle, status: 'prepared' })))
      await until(() => prepares(b1, h).length === 4, 'credit prepares')
      // Any later pass — another report, a client's signature, a restart without redrive.
      await server.core.process(ledger, h)
      await server.core.process(ledger, h)
      await quiet()
      assert.equal(prepares(b1, h).length, 4)
    })

    test('a bridge that never answers a prepare: the intent expires and the part is aborted', async () => {
      const { sdk, as2 } = await books({}, { 'intent.expiryThresholdMinutes': 1 })
      server.core.startExpiry(20)
      try {
        const h = await send(sdk, [t('alice', 'b2', 2)])
        await until(() => prepares(b2, h)[0], 'credit prepare')
        const abort = await until(() => of(b2, h).find((c) => c.url.endsWith('/abort')), 'abort after expiry', 5_000)
        await report(as2, k2, abort.body.data.intent, { handle: abort.body.data.handle, status: 'aborted' })
        const done = await settle(sdk, h)
        assert.equal(done.meta.status, 'rejected')
        assert.ok(done.meta.proofs.some((p: any) => p.custom.reason === 'core.intent-expired'))
        assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
      } finally {
        server.core.stopExpiry()
      }
    })
  })
}
