// L1: money moves inside one ledger. Behaviour first (what a client sees), then the
// invariants that must hold whatever the sequence: conservation of supply, no negative
// available balance, reservations released, and no overdraft under concurrency.
// Every test runs against each store in STORES.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STORES, balanceOf, failure, newKeyPair, newLedger, ref, sendIntent, settle, setupBooks, startServer, type KeyPair } from './helpers.js'

const usd = ref('usd')
const issue = (to: string, amount: number) => ({ action: 'issue', target: ref(to), symbol: usd, amount })
const transfer = (from: string, to: string, amount: number) => ({ action: 'transfer', source: ref(from), target: ref(to), symbol: usd, amount })
const destroy = (from: string, amount: number) => ({ action: 'destroy', source: ref(from), symbol: usd, amount })
const failedProof = (intent: any) => intent.meta.proofs.find((p: any) => p.custom?.status === 'failed')?.custom

for (const [storeName, makeStore] of STORES) {
  describe(`L1 on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let kp: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      kp = await newKeyPair()
    })
    after(() => server.close())

    async function books(wallets = ['alice', 'bob']) {
      const { sdk } = await newLedger(server.base, kp)
      await setupBooks(sdk, kp, wallets)
      const run = async (...claims: unknown[]) => settle(sdk, await sendIntent(sdk, kp, claims))
      return { sdk, run }
    }

    test('an intent is accepted as pending and completes asynchronously', async () => {
      const { sdk } = await books()
      const res: any = await sdk.intent.init().data({ handle: 'p1', claims: [issue('alice', 1)] } as any).hash().sign([{ keyPair: kp }]).send()
      assert.equal(res.meta.status, 'pending')
      assert.equal((await settle(sdk, 'p1')).meta.status, 'completed')
    })

    test('issue, transfer and destroy move balances', async () => {
      const { sdk, run } = await books()
      assert.equal((await run(issue('alice', 10_000))).meta.status, 'completed')
      assert.equal((await run(transfer('alice', 'bob', 2_500))).meta.status, 'completed')
      assert.equal((await run(destroy('bob', 500))).meta.status, 'completed')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 7_500, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'bob'), { available: 2_000, reserved: 0 })
    })

    test('overdraw is rejected with core.limit-exceeded and leaves balances untouched', async () => {
      const { sdk, run } = await books()
      await run(issue('alice', 100))
      const r = await run(transfer('alice', 'bob', 101))
      assert.equal(r.meta.status, 'rejected')
      assert.deepEqual(failedProof(r), {
        ...failedProof(r),
        reason: 'core.limit-exceeded',
        detail: 'Amount -1 is less than minimum allowed amount 0 for wallet alice, symbol usd, schema available',
      })
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'bob'), { available: 0, reserved: 0 })
    })

    test('a multi-claim intent is all or nothing', async () => {
      const { sdk, run } = await books()
      await run(issue('alice', 100))
      const r = await run(transfer('alice', 'bob', 50), transfer('bob', 'alice', 1_000))
      assert.equal(r.meta.status, 'rejected')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'bob'), { available: 0, reserved: 0 })
    })

    test('two debits from one wallet in one intent are checked together', async () => {
      const { sdk, run } = await books()
      await run(issue('alice', 100))
      const r = await run(transfer('alice', 'bob', 60), transfer('alice', 'bob', 60))
      assert.equal(r.meta.status, 'rejected')
      assert.match(failedProof(r).detail, /^Amount -20 is less than/)
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
    })

    test('unknown wallet and unknown symbol reject during resolution', async () => {
      const { run } = await books()
      const ghost = await run(transfer('alice', 'ghost', 1))
      assert.equal(failedProof(ghost).reason, 'core.routing-failed')
      const eur = await run({ action: 'issue', target: ref('alice'), symbol: ref('eur'), amount: 1 })
      assert.deepEqual([failedProof(eur).reason, failedProof(eur).detail], ['core.symbol-invalid', 'Symbol eur not found.'])
      // Resolution failures carry no resolved entries.
      assert.ok(!ghost.meta.proofs.some((p: any) => p.custom?.status === 'resolved'))
    })

    test('duplicate intent handle is 409 and does not move money twice', async () => {
      const { sdk } = await books()
      const h = await sendIntent(sdk, kp, [issue('alice', 5)], 'once')
      const e = await failure(sendIntent(sdk, kp, [issue('alice', 5)], 'once'))
      assert.deepEqual([e.status, e.reason, e.detail], [409, 'record.duplicated', 'Intent with handle once already exists.'])
      await settle(sdk, h)
      assert.equal((await balanceOf(sdk, 'alice')).available, 5)
    })

    test('schema errors mirror the reference, including oneOf branches', async () => {
      const { sdk } = await books()
      const e = await failure(sendIntent(sdk, kp, [issue('alice', 0)]))
      assert.equal(e.reason, 'record.schema-invalid')
      assert.deepEqual(
        e.body.data.custom.errors.map((x: any) => x.errorCode),
        ['exclusiveMinimum', 'required', 'required', 'required', 'oneOf'].map((k) => `${k}.openapi.validation`),
      )
    })

    // Model-based: a random sequence of intents, each settled before the next, must
    // leave exactly the balances a trivial sequential model predicts.
    test('random sequences agree with a sequential model and conserve supply', async () => {
      const wallets = ['w0', 'w1', 'w2', 'w3']
      const { sdk, run } = await books(wallets)
      const model = new Map(wallets.map((w) => [w, 0]))
      let supply = 0
      let seed = 42
      const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)

      for (let i = 0; i < 60; i++) {
        const a = wallets[rnd(4)], b = wallets[rnd(4)], amount = 1 + rnd(400)
        const kind = rnd(10)
        const claims = kind < 3 ? [issue(a, amount)] : kind < 5 ? [destroy(a, amount)] : [transfer(a, b, amount)]
        const r = await run(...claims)

        const debit = kind < 3 ? 0 : amount
        const ok = model.get(a)! - debit >= 0
        assert.equal(r.meta.status, ok ? 'completed' : 'rejected', `step ${i}: ${JSON.stringify(claims)}`)
        if (!ok) continue
        if (kind < 3) (model.set(a, model.get(a)! + amount), (supply += amount))
        else if (kind < 5) (model.set(a, model.get(a)! - amount), (supply -= amount))
        else (model.set(a, model.get(a)! - amount), model.set(b, model.get(b)! + amount))
      }

      let total = 0
      for (const w of wallets) {
        const bal = await balanceOf(sdk, w)
        assert.deepEqual(bal, { available: model.get(w), reserved: 0 }, w)
        assert.ok(bal.available >= 0)
        total += bal.available
      }
      assert.equal(total, supply, 'sum of balances equals issued minus destroyed')
    })

    test('concurrent transfers never overdraw', async () => {
      const { sdk, run } = await books()
      await run(issue('alice', 1_000))
      const handles = await Promise.all(Array.from({ length: 50 }, () => sendIntent(sdk, kp, [transfer('alice', 'bob', 100)])))
      const results = await Promise.all(handles.map((h) => settle(sdk, h, 30_000)))
      const completed = results.filter((r) => r.meta.status === 'completed').length
      assert.equal(completed, 10)
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 0, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'bob'), { available: 1_000, reserved: 0 })
    })
  })
}
