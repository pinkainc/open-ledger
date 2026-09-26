// Claim permissions and intent expiry (FINDINGS, access4). An intent whose signers
// lack a permission stays pending after resolution and is rejected when it expires.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Core } from '../src/core.js'
import { STORES, balanceOf, newKeyPair, newLedger, ref, sdkFor, settle, startServer, type KeyPair } from './helpers.js'

const MINUTE = 50 // ms: one minute of expiry in these tests

for (const [storeName, makeStore] of STORES) {
  describe(`claim permissions on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let a: KeyPair, b: KeyPair
    before(async () => {
      const store = await makeStore()
      server = await startServer(store, new Core(store, { minuteMs: MINUTE }))
      a = await newKeyPair()
      b = await newKeyPair()
    })
    after(() => server.close())

    const raw = async (p: Promise<any>) => (await p).response.data
    const only = (k: KeyPair) => [{ action: 'any', signer: { public: k.public } }]
    let seq = 0

    /** A ledger like access4's: A may do anything, B may enter and create intents. */
    async function books(expiryMinutes: number | null = 1, walletAccess = only(a)) {
      const access = [
        { action: 'any', record: 'any', signer: { public: a.public } },
        { action: 'access', signer: { public: b.public } },
        { action: 'create', record: 'intent' },
        { action: 'read', record: 'any' },
      ]
      const config = expiryMinutes === null ? { 'access.strategy': 'record-based' } : { 'intent.expiryThresholdMinutes': expiryMinutes }
      const { handle, sdk } = await newLedger(server.base, a, access, config)
      const s: any = sdk
      await s.symbol.init().data({ handle: 'usd', factor: 100, access: only(a) }).hash().sign([{ keyPair: a }]).send()
      for (const w of ['alice', 'bobw']) await s.wallet.init().data({ handle: w, access: walletAccess }).hash().sign([{ keyPair: a }]).send()
      return { handle, asA: s, asB: sdkFor(server.base, handle, b) as any }
    }

    async function send(sdk: any, keys: KeyPair[], claims: unknown[]) {
      const handle = `c-${++seq}`
      await sdk.intent.init().data({ handle, claims }).hash().sign(keys.map((k) => ({ keyPair: k }))).send()
      return handle
    }
    const issue = (w: string, amount = 100) => ({ action: 'issue', target: ref(w), symbol: ref('usd'), amount })
    const spend = (from: string, to: string, amount = 10) => ({ action: 'transfer', source: ref(from), target: ref(to), symbol: ref('usd'), amount })
    const statuses = (i: any) => i.meta.proofs.map((p: any) => p.custom.status)

    /** Waits until background processing has had its turn with an intent. */
    async function processed(sdk: any, handle: string) {
      for (let n = 0; n < 200; n++) {
        const i = await raw(sdk.intent.read(handle))
        if (i.meta.status !== 'pending' || statuses(i).includes('resolved')) return i
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error(`${handle} never processed`)
    }

    test('an issue without `issue` on the symbol waits after resolution, then expires', async () => {
      const { asA, asB } = await books()
      const h = await send(asB, [b], [issue('bobw')])
      const waiting = await processed(asA, h)
      assert.equal(waiting.meta.status, 'pending')
      assert.deepEqual(statuses(waiting), ['created', 'pending', 'pending', 'resolved'])
      assert.deepEqual(await balanceOf(asA, 'bobw'), { available: 0, reserved: 0 })

      await new Promise((r) => setTimeout(r, MINUTE * 1.5))
      await server.core.expire()
      const done = await raw(asA.intent.read(h))
      assert.equal(done.meta.status, 'rejected')
      assert.deepEqual(statuses(done).slice(-3), ['failed', 'aborted', 'rejected'])
      const failed = done.meta.proofs.at(-3).custom
      assert.deepEqual([failed.reason, failed.detail], ['core.intent-expired', `Intent ${h} expired`])
      assert.equal(done.meta.routed, undefined)
    })

    test('a spend without `spend` on the source reserves nothing and expires', async () => {
      const { asA, asB } = await books()
      await settle(asA, await send(asA, [a], [issue('alice', 1000)]))
      const h = await send(asB, [b], [spend('alice', 'bobw')])
      const waiting = await processed(asA, h)
      assert.deepEqual(statuses(waiting).slice(-2), ['resolved', 'resolved'])
      assert.deepEqual(await balanceOf(asA, 'alice'), { available: 1000, reserved: 0 })
      await new Promise((r) => setTimeout(r, MINUTE * 1.5))
      await server.core.expire()
      assert.equal((await raw(asA.intent.read(h))).meta.status, 'rejected')
      assert.deepEqual(await balanceOf(asA, 'alice'), { available: 1000, reserved: 0 })
    })

    test('a spend signed by the wallet owner as well completes', async () => {
      const { asA, asB } = await books()
      await settle(asA, await send(asA, [a], [issue('alice', 1000)]))
      const done = await settle(asA, await send(asB, [a, b], [spend('alice', 'bobw')]))
      assert.equal(done.meta.status, 'completed')
      assert.deepEqual(await balanceOf(asA, 'bobw'), { available: 10, reserved: 0 })
    })

    test('`$record: owner` grants spend to the key that created the wallet', async () => {
      const { asA } = await books(1, [{ action: 'spend', signer: { $record: 'owner' } }] as any)
      await settle(asA, await send(asA, [a], [issue('alice', 100)]))
      assert.equal((await settle(asA, await send(asA, [a], [spend('alice', 'bobw')]))).meta.status, 'completed')
    })

    test('a limit claim needs `limit` on the wallet', async () => {
      const { asA, asB } = await books()
      const h = await send(asB, [b], [{ action: 'limit', wallet: ref('alice'), symbol: ref('usd'), amount: -100, metric: 'minBalance' }])
      await new Promise((r) => setTimeout(r, 20))
      assert.equal((await raw(asA.intent.read(h))).meta.status, 'pending')
      const ok = await settle(asA, await send(asA, [a], [{ action: 'limit', wallet: ref('alice'), symbol: ref('usd'), amount: -100, metric: 'minBalance' }]))
      assert.equal(ok.meta.status, 'completed')
    })

    test('a token of a registered signer authorises its claims through impersonation', async () => {
      const { handle, asA } = await books()
      await asA.signer.init().data({ handle: 'a', public: a.public, format: 'ed25519-raw' }).hash().sign([{ keyPair: a }]).send()
      await settle(asA, await send(asA, [a], [issue('alice', 100)]))
      // Signed by B only, but sent with A's token: system.auth signs for A.
      const withAToken = sdkFor(server.base, handle, a) as any
      const done = await settle(asA, await send(withAToken, [b], [spend('alice', 'bobw')]))
      assert.equal(done.meta.status, 'completed')
    })

    test('an intent is not expired before its threshold, nor on a ledger without one', async () => {
      const long = await books(60)
      const h1 = await send(long.asB, [b], [issue('bobw')])
      const none = await books(null)
      const h2 = await send(none.asB, [b], [issue('bobw')])
      await processed(long.asA, h1)
      await processed(none.asA, h2)
      await new Promise((r) => setTimeout(r, MINUTE * 1.5))
      await server.core.expire()
      assert.equal((await raw(long.asA.intent.read(h1))).meta.status, 'pending')
      assert.equal((await raw(none.asA.intent.read(h2))).meta.status, 'pending')
    })

    test('processing a waiting intent again does not resolve it twice', async () => {
      const { handle, asA, asB } = await books()
      const h = await send(asB, [b], [spend('alice', 'bobw')])
      await processed(asA, h)
      await server.core.process(handle, h)
      const i = await raw(asA.intent.read(h))
      assert.deepEqual(statuses(i), ['created', 'pending', 'pending', 'resolved', 'resolved'])
    })
  })
}
