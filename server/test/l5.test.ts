// L5: two-phase commit with one bridge (recorded in l5). The invariant this level adds:
// a bridge report delivered N times has the effect of one.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Core } from '../src/core.js'
import { STORES, balanceOf, failure, newKeyPair, newLedger, ref, sdkFor, settle, startServer, testBridge, until, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`L5 bridges on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let bridge: Awaited<ReturnType<typeof testBridge>>
    let kp: KeyPair, bank: KeyPair
    before(async () => {
      const store = await makeStore()
      server = await startServer(store, new Core(store, { minuteMs: 100, bridges: { retryMs: 20 } }))
      bridge = await testBridge()
      kp = await newKeyPair()
      bank = await newKeyPair()
    })
    after(async () => {
      await server.close()
      await bridge.close()
    })

    const raw = async (p: Promise<any>) => (await p).response.data
    let seq = 0

    async function books(config?: Record<string, unknown>) {
      const { handle, sdk } = await newLedger(server.base, kp, [{ action: 'any', record: 'any' }], config)
      const s: any = sdk
      await s.bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: bridge.url }, secure: [] }).hash().sign([{ keyPair: kp }]).send()
      await s.signer.init().data({ handle: 'bank', public: bank.public, format: 'ed25519-raw' }).hash().sign([{ keyPair: kp }]).send()
      await s.symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign([{ keyPair: kp }]).send()
      await s.wallet.init().data({ handle: 'alice' }).hash().sign([{ keyPair: kp }]).send()
      await s.wallet.init().data({ handle: 'acc', bridge: 'bank' }).hash().sign([{ keyPair: kp }]).send()
      const asBank: any = sdkFor(server.base, handle, bank)
      return { handle, sdk: s, asBank }
    }

    async function send(sdk: any, claims: unknown[]) {
      const handle = `b-${++seq}`
      await sdk.intent.init().data({ handle, claims }).hash().sign([{ keyPair: kp }]).send()
      return handle
    }
    const transfer = (from: string, to: string, amount: number) => ({ action: 'transfer', source: ref(from), target: ref(to), symbol: ref('usd'), amount })
    const issue = (to: string, amount: number) => ({ action: 'issue', target: ref(to), symbol: ref('usd'), amount })

    const callsFor = (intent: string) => bridge.calls.filter((c) => (c.body?.data?.intent?.data?.handle ?? c.body?.data?.handle) === intent)
    const prepareOf = (intent: string) => until(() => callsFor(intent).find((c) => /\/(debits|credits)$/.test(c.url)), `prepare of ${intent}`)
    /** The bridge signs the intent it was sent, about one entry. */
    async function report(asBank: any, intentRecord: any, custom: Record<string, unknown>) {
      return raw(asBank.intent.from(intentRecord).sign([{ keyPair: bank, custom }]).send())
    }
    const statuses = (i: any) => i.meta.proofs.map((p: any) => `${p.signer ?? '-'}:${p.custom.status}`)

    test('a credit to a bridged wallet: prepare, prepared, commit, committed, completed', async () => {
      const { sdk, asBank } = await books()
      await settle(sdk, await send(sdk, [issue('alice', 100)]))
      const h = await send(sdk, [transfer('alice', 'acc', 10)])
      const prepare = await prepareOf(h)
      const entry = prepare.body.data
      assert.equal(prepare.url, '/v2/credits')
      assert.deepEqual([entry.schema, entry.amount, entry.source, entry.target, entry.inputs], ['credit', 10, { handle: 'alice' }, { handle: 'acc' }, [0]])
      assert.match(entry.luid, /^\$ben\./)
      assert.equal(entry.intent.meta.status, 'pending')
      assert.equal(entry.intent.meta.domains, undefined)
      // While the bridge has not answered, the debit is reserved.
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 90, reserved: 10 })

      await report(asBank, entry.intent, { handle: entry.handle, status: 'prepared', coreId: '1' })
      const commit = await until(() => callsFor(h).find((c) => c.url.endsWith('/commit')), 'commit')
      assert.equal(commit.url, `/v2/credits/${entry.handle}/commit`)
      assert.deepEqual([commit.body.data.action, commit.body.data.intent.meta.status, commit.body.data.intent.meta.routed], ['commit', 'committed', true])
      assert.equal((await raw(sdk.intent.read(h))).meta.status, 'committed')

      await report(asBank, commit.body.data.intent, { handle: entry.handle, status: 'committed', coreId: '1' })
      const done = await settle(sdk, h)
      assert.equal(done.meta.status, 'completed')
      const intent = await raw(sdk.intent.read(h))
      assert.deepEqual(statuses(intent).slice(3), [
        'system:resolved', 'system:resolved', 'core:prepared', 'core:prepared', 'bank:prepared', 'system:prepared',
        'system:committed', '-:committed', '-:committed', 'bank:committed', 'system:completed',
      ])
      assert.equal(intent.meta.proofs[4].custom.bridge, 'bank')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 90, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'acc'), { available: 10, reserved: 0 })
      const puts = await until(() => { const p = callsFor(h).filter((c) => c.method === 'PUT'); return p.length === 2 ? p : undefined }, 'status notifications')
      assert.deepEqual(puts.map((p) => [p.url, p.body.meta.status]), [[`/v2/intents/${h}`, 'prepared'], [`/v2/intents/${h}`, 'completed']])
    })

    test('a failed prepare aborts every bridged entry, releases the reservation and rejects', async () => {
      const { sdk, asBank } = await books()
      await settle(sdk, await send(sdk, [issue('alice', 100)]))
      const h = await send(sdk, [transfer('alice', 'acc', 7)])
      const entry = (await prepareOf(h)).body.data
      await report(asBank, entry.intent, { handle: entry.handle, status: 'failed', reason: 'bridge.unexpected-error', detail: 'closed' })
      const abort = await until(() => callsFor(h).find((c) => c.url.endsWith('/abort')), 'abort')
      assert.equal(abort.body.data.intent.meta.status, 'aborted')
      const failed = abort.body.data.intent.meta.proofs.find((p: any) => p.signer === 'system' && p.custom.status === 'failed').custom
      assert.deepEqual([failed.reason, failed.detail], ['core.bridge-prepare-failed', 'Bridge(s) failed to process intent: bank'])
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 93, reserved: 7 })

      await report(asBank, abort.body.data.intent, { handle: entry.handle, status: 'aborted', coreId: '1' })
      const done = await settle(sdk, h)
      assert.equal(done.meta.status, 'rejected')
      const intent = await raw(sdk.intent.read(h))
      assert.deepEqual(statuses(intent).slice(-4), ['bank:aborted', 'core:aborted', 'core:aborted', 'system:rejected'])
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
      const puts = await until(() => { const p = callsFor(h).filter((c) => c.method === 'PUT'); return p.length ? p : undefined }, 'final notification')
      assert.deepEqual(puts.map((p) => p.body.meta.status), ['rejected'])
    })

    test('a prepare the bridge refuses over HTTP is retried with the same entry', async () => {
      const { sdk } = await books()
      await settle(sdk, await send(sdk, [issue('alice', 100)]))
      let first = true
      bridge.answerWith((c) => (first && /\/credits$/.test(c.url) ? ((first = false), 500) : 202))
      const h = await send(sdk, [transfer('alice', 'acc', 3)])
      const tries = await until(() => { const t = callsFor(h).filter((c) => /\/credits$/.test(c.url)); return t.length >= 2 ? t : undefined }, 'retry')
      bridge.answerWith(() => 202)
      assert.equal(tries[0].body.data.luid, tries[1].body.data.luid)
      assert.equal(tries[0].body.hash, tries[1].body.hash)
    })

    test('an issue to a bridged wallet does not call the bridge', async () => {
      const { sdk } = await books()
      const h = await send(sdk, [issue('acc', 50)])
      const done = await settle(sdk, h)
      assert.equal(done.meta.status, 'completed')
      const intent = await raw(sdk.intent.read(h))
      assert.equal(intent.meta.proofs[3].custom.bridge, 'bank')
      assert.deepEqual(callsFor(h), [])
    })

    test('a report delivered twice has the effect of one', async () => {
      const { sdk, asBank } = await books()
      await settle(sdk, await send(sdk, [issue('alice', 100)]))
      const h = await send(sdk, [transfer('alice', 'acc', 10)])
      const entry = (await prepareOf(h)).body.data
      await report(asBank, entry.intent, { handle: entry.handle, status: 'prepared', coreId: '1' })
      await report(asBank, entry.intent, { handle: entry.handle, status: 'prepared', coreId: '1' })
      const commit = await until(() => callsFor(h).find((c) => c.url.endsWith('/commit')), 'commit')
      await report(asBank, commit.body.data.intent, { handle: entry.handle, status: 'committed', coreId: '1' })
      await report(asBank, commit.body.data.intent, { handle: entry.handle, status: 'committed', coreId: '1' })
      await settle(sdk, h)
      await new Promise((r) => setTimeout(r, 50))
      const intent = await raw(sdk.intent.read(h))
      assert.equal(statuses(intent).filter((s: string) => s === 'system:prepared').length, 1)
      assert.equal(statuses(intent).filter((s: string) => s === 'system:completed').length, 1, statuses(intent).join(' '))
      assert.equal(callsFor(h).filter((c) => c.url.endsWith('/commit')).length, 1)
      assert.deepEqual(await balanceOf(sdk, 'acc'), { available: 10, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 90, reserved: 0 })
    })

    test('an intent waiting for its bridge expires: abort, release, rejected', async () => {
      const { sdk, asBank } = await books({ 'intent.expiryThresholdMinutes': 1 })
      await settle(sdk, await send(sdk, [issue('alice', 100)]))
      const h = await send(sdk, [transfer('alice', 'acc', 10)])
      await prepareOf(h)
      await new Promise((r) => setTimeout(r, 150))
      await server.core.expire()
      const abort = await until(() => callsFor(h).find((c) => c.url.endsWith('/abort')), 'abort')
      const failed = abort.body.data.intent.meta.proofs.find((p: any) => p.custom.reason).custom
      assert.deepEqual([failed.reason, failed.detail], ['core.intent-expired', `Intent ${h} expired`])
      await report(asBank, abort.body.data.intent, { handle: abort.body.data.handle, status: 'aborted' })
      assert.equal((await settle(sdk, h)).meta.status, 'rejected')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
    })

    test('references: a wallet names an existing bridge; a bridge names its schema', async () => {
      const { sdk } = await books()
      const w = await failure(sdk.wallet.init().data({ handle: 'x', bridge: 'nope' }).hash().sign([{ keyPair: kp }]).send())
      assert.deepEqual([w.status, w.reason, w.detail], [422, 'record.relation-not-found', 'Referenced Bridge nope not found.'])
      const b = await failure(sdk.bridge.init().data({ handle: 'b2', config: { server: bridge.url }, secure: [] }).hash().sign([{ keyPair: kp }]).send())
      assert.deepEqual([b.status, b.reason, b.detail], [422, 'record.schema-invalid', 'There are schemas defined for record of type bridge, you must specify at least one.'])
    })
  })
}

test('after a restart, calls in flight are sent again with the same entry', async () => {
  const { MemoryStore } = await import('../src/store.js')
  const store = new MemoryStore()
  const bridge = await testBridge()
  const kp = await newKeyPair()
  const first = await startServer(store, new Core(store, { bridges: { retryMs: 20 } }))
  const { handle, sdk } = await newLedger(first.base, kp)
  const s: any = sdk
  await s.bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: bridge.url }, secure: [] }).hash().sign([{ keyPair: kp }]).send()
  await s.symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign([{ keyPair: kp }]).send()
  await s.wallet.init().data({ handle: 'alice' }).hash().sign([{ keyPair: kp }]).send()
  await s.wallet.init().data({ handle: 'acc', bridge: 'bank' }).hash().sign([{ keyPair: kp }]).send()
  await s.intent.init().data({ handle: 'fund', claims: [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 5 }] }).hash().sign([{ keyPair: kp }]).send()
  await settle(s, 'fund')
  await s.intent.init().data({ handle: 'out', claims: [{ action: 'transfer', source: ref('alice'), target: ref('acc'), symbol: ref('usd'), amount: 5 }] }).hash().sign([{ keyPair: kp }]).send()
  const firstCall = await until(() => bridge.calls.find((c) => c.url === '/v2/credits'), 'first prepare')
  first.core.close()

  const core = new Core(store, { bridges: { retryMs: 20 } })
  await core.resume()
  const again = await until(() => { const c = bridge.calls.filter((c) => c.url === '/v2/credits'); return c.length === 2 ? c[1] : undefined }, 'prepare again')
  assert.equal(again.body.data.luid, firstCall.body.data.luid)
  assert.equal(again.body.data.handle, firstCall.body.data.handle)
  core.close()
  await first.close()
  await bridge.close()
  void handle
})
