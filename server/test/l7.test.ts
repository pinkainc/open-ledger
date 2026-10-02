// L7: threads (recorded in l7). A forward route makes a new intent in the thread of
// the intent that credited the wallet; the thread commits as one, and fails as one.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Core, MAX_THREAD } from '../src/core.js'
import { STORES, balanceOf, newKeyPair, newLedger, ref, sdkFor, settle, startServer, testBridge, until, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`L7 threads on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let bank: Awaited<ReturnType<typeof testBridge>>
    let kp: KeyPair, kb: KeyPair
    before(async () => {
      const store = await makeStore()
      const core = new Core(store, { minuteMs: 200, bridges: { retryMs: 20 } })
      server = await startServer(store, core)
      core.startExpiry(50)
      bank = await testBridge()
      kp = await newKeyPair()
      kb = await newKeyPair()
    })
    after(async () => {
      await server.close()
      await bank.close()
    })

    const raw = async (p: Promise<any>) => (await p).response.data
    let seq = 0
    const t = (from: string, to: string, amount: number) => ({ action: 'transfer', source: ref(from), target: ref(to), symbol: ref('usd'), amount })

    // alice is native; acct belongs to the bank; fwd forwards to `target`.
    async function books(wallets: Record<string, Record<string, unknown>>, config?: Record<string, unknown>) {
      const { handle, sdk } = await newLedger(server.base, kp, [{ action: "any", record: "any" }], config)
      const s: any = sdk
      const sign = [{ keyPair: kp }]
      await s.bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: bank.url }, secure: [] }).hash().sign(sign).send()
      await s.signer.init().data({ handle: 'bank', public: kb.public, format: 'ed25519-raw' }).hash().sign(sign).send()
      await s.symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign(sign).send()
      for (const [w, data] of Object.entries({ alice: {}, acct: { bridge: 'bank' }, ...wallets })) await s.wallet.init().data({ handle: w, ...data }).hash().sign(sign).send()
      await settle(s, await send(s, [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 100 }]))
      return { sdk: s, asBank: sdkFor(server.base, handle, kb) as any }
    }
    async function send(sdk: any, claims: unknown[]) {
      const handle = `t-${++seq}`
      await sdk.intent.init().data({ handle, claims }).hash().sign([{ keyPair: kp }]).send()
      return handle
    }
    const all = async (sdk: any) => (await raw(sdk.intent.list({ page: { index: 0, limit: 50 } }))).data as any[]
    const childOf = async (sdk: any, origin: string) => (await all(sdk)).find((i) => i.data.origin === origin)
    const status = async (sdk: any, h: string) => (await raw(sdk.intent.read(h))).meta.status
    const trail = (i: any) => i.meta.proofs.map((p: any) => `${p.signer ?? '-'}:${p.custom.status}`)
    const failed = (i: any) => i.meta.proofs.find((p: any) => p.custom.status === 'failed')?.custom
    const prepares = (origin: string) => bank.calls.filter((c) => /\/(credits|debits)$/.test(c.url) && c.body?.data?.intent?.data?.origin === origin)

    test('a refused forward intent rejects the intent that made it, with its reason', async () => {
      const { sdk } = await books({ strict: { routes: [{ action: 'accept', filter: { 'symbol.handle': 'eur' } }] }, fwd: { routes: [{ action: 'forward', target: 'strict' }] } })
      const h = await send(sdk, [t('alice', 'fwd', 3)])
      const first = await settle(sdk, h)
      const child = await settle(sdk, (await childOf(sdk, h)).data.handle)
      assert.equal(child.meta.status, 'rejected')
      assert.equal(first.meta.status, 'rejected')
      assert.deepEqual(failed(first), { ...failed(child), moment: failed(first).moment })
      assert.equal(failed(first).reason, 'core.routing-failed')
      // Recorded trail of the first intent: prepared, then the thread's failure.
      assert.deepEqual(trail(first).slice(5), ['core:prepared', 'core:prepared', 'system:prepared', 'system:failed', 'system:aborted', 'core:aborted', 'core:aborted', 'system:rejected'])
      assert.deepEqual(trail(child), ['-:created', 'system:pending', 'system:pending', 'system:failed', 'system:aborted', 'system:rejected'])
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'fwd'), { available: 0, reserved: 0 })
    })

    test('the first intent waits, prepared, until its forward intent is prepared; then both commit', async () => {
      const { sdk, asBank } = await books({ fwd: { routes: [{ action: 'forward', target: 'acct' }] } })
      const h = await send(sdk, [t('alice', 'fwd', 6)])
      const prepare = await until(() => prepares(h)[0], 'credit prepare of the forward intent')
      assert.equal(await status(sdk, h), 'prepared', 'the first intent waits for its thread')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 94, reserved: 6 })
      const entry = prepare.body.data
      await raw(asBank.intent.from(entry.intent).sign([{ keyPair: kb, custom: { handle: entry.handle, status: 'prepared' } }]).send())
      const commit = await until(() => bank.calls.find((c) => c.url === `/v2/credits/${entry.handle}/commit`), 'commit')
      assert.equal((await settle(sdk, h)).meta.status, 'completed')
      await raw(asBank.intent.from(commit.body.data.intent).sign([{ keyPair: kb, custom: { handle: entry.handle, status: 'committed' } }]).send())
      assert.equal((await settle(sdk, entry.intent.data.handle)).meta.status, 'completed')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 94, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'fwd'), { available: 0, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'acct'), { available: 6, reserved: 0 })
    })

    test('a forward intent whose bridge fails the prepare: the thread is rejected, the bridge told to abort', async () => {
      const { sdk, asBank } = await books({ fwd: { routes: [{ action: 'forward', target: 'acct' }] } })
      const h = await send(sdk, [t('alice', 'fwd', 4)])
      const prepare = await until(() => prepares(h)[0], 'credit prepare')
      const entry = prepare.body.data
      // Prepared once, even though the forward intent is processed again on every report.
      await raw(asBank.intent.from(entry.intent).sign([{ keyPair: kb, custom: { handle: entry.handle, status: 'failed', reason: 'bridge.unexpected-error', detail: 'Account closed' } }]).send())
      const abort = await until(() => bank.calls.find((c) => c.url === `/v2/credits/${entry.handle}/abort`), 'abort')
      assert.equal(prepares(h).length, 1)
      assert.equal((await settle(sdk, h)).meta.status, 'rejected')
      assert.equal(failed(await raw(sdk.intent.read(h))).detail, 'Bridge(s) failed to process intent: bank')
      await raw(asBank.intent.from(abort.body.data.intent).sign([{ keyPair: kb, custom: { handle: entry.handle, status: 'aborted' } }]).send())
      assert.equal((await settle(sdk, entry.intent.data.handle)).meta.status, 'rejected')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
    })

    // A deliberate divergence: the reference never expires this thread (recorded).
    test('a forward intent the bridge never answers expires, and its thread with it', async () => {
      const { sdk, asBank } = await books({ fwd: { routes: [{ action: 'forward', target: 'acct' }] } }, { 'intent.expiryThresholdMinutes': 1 })
      const h = await send(sdk, [t('alice', 'fwd', 5)])
      const prepare = await until(() => prepares(h)[0], 'credit prepare')
      const first = await settle(sdk, h, 5_000)
      assert.equal(first.meta.status, 'rejected')
      assert.equal(failed(first).reason, 'core.intent-expired')
      assert.equal(failed(first).detail, `Intent ${prepare.body.data.intent.data.handle} expired`)
      const abort = await until(() => bank.calls.find((c) => c.url === `/v2/credits/${prepare.body.data.handle}/abort`), 'abort')
      await raw(asBank.intent.from(abort.body.data.intent).sign([{ keyPair: kb, custom: { handle: prepare.body.data.handle, status: 'aborted' } }]).send())
      assert.equal((await settle(sdk, prepare.body.data.intent.data.handle)).meta.status, 'rejected')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
    })

    // A deliberate divergence: the reference lets the loop run and checks the size later.
    test(`a forward loop stops at ${MAX_THREAD} intents and rejects the whole thread`, async () => {
      const { sdk } = await books({ 'loop-a': { routes: [{ action: 'forward', target: 'loop-b' }] }, 'loop-b': { routes: [{ action: 'forward', target: 'loop-a' }] } })
      const h = await send(sdk, [t('alice', 'loop-a', 1)])
      const first = await settle(sdk, h)
      assert.equal(first.meta.status, 'rejected')
      assert.deepEqual(failed(first), { ...failed(first), reason: 'core.thread-size-exceeded', detail: `Thread size exceeded the maximum of ${MAX_THREAD}` })
      const thread = (await all(sdk)).filter((i) => i.meta.thread === first.meta.thread)
      assert.equal(thread.length, MAX_THREAD)
      for (const i of thread) assert.equal((await settle(sdk, i.data.handle)).meta.status, 'rejected')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
      for (const w of ['loop-a', 'loop-b']) assert.deepEqual(await balanceOf(sdk, w), { available: 0, reserved: 0 })
    })
  })
}
