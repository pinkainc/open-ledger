// L3: limits, and the rules L1 left open — credits never offset debits, lists are
// newest first and paginated, balances sort by symbol and schema, intents read by luid.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STORES, balanceOf, newKeyPair, newLedger, ref, sendIntent, settle, setupBooks, startServer, type KeyPair } from './helpers.js'
import { digestFor, hashData, verifyDigest } from '../src/crypto.js'

const usd = ref('usd')
const issue = (to: string, amount: number, symbol = usd) => ({ action: 'issue', target: ref(to), symbol, amount })
const transfer = (from: string, to: string, amount: number) => ({ action: 'transfer', source: ref(from), target: ref(to), symbol: usd, amount })
const limit = (wallet: string, metric: string, amount: number) => ({ action: 'limit', metric, wallet: ref(wallet), symbol: usd, amount })
const failed = (i: any) => i.meta.proofs.find((p: any) => p.custom?.status === 'failed')?.custom

for (const [storeName, makeStore] of STORES) {
  describe(`L3 on ${storeName}`, () => {
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

    test('minBalance allows an overdraft down to the limit and no further', async () => {
      const { sdk, run } = await books()
      assert.equal((await run(limit('alice', 'minBalance', -500))).meta.status, 'completed')
      assert.equal((await run(transfer('alice', 'bob', 400))).meta.status, 'completed')
      const r = await run(transfer('alice', 'bob', 101))
      assert.equal(failed(r).detail, 'Amount -501 is less than minimum allowed amount -500 for wallet alice, symbol usd, schema available')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: -400, reserved: 0 })
    })

    test('maxBalance rejects a credit that would exceed it (deliberate divergence)', async () => {
      const { sdk, run } = await books()
      await run(limit('bob', 'maxBalance', 1000))
      assert.equal((await run(issue('bob', 1000))).meta.status, 'completed')
      const r = await run(issue('bob', 1))
      assert.equal(r.meta.status, 'rejected')
      assert.equal(failed(r).detail, 'Amount 1001 is greater than maximum allowed amount 1000 for wallet bob, symbol usd, schema available')
      assert.equal((await balanceOf(sdk, 'bob')).available, 1000)
    })

    test('a later limit claim replaces the amount and keeps the row', async () => {
      const { sdk, run } = await books()
      await run(limit('alice', 'minBalance', -100))
      const first: any = await sdk.wallet.getLimits('alice')
      await run(limit('alice', 'minBalance', -300))
      const second: any = await sdk.wallet.getLimits('alice')
      assert.equal(second.limits.length, 1)
      assert.equal(second.limits[0].amount, -300)
      const raw = second.response.data.data[0]
      assert.equal(raw.luid, first.response.data.data[0].luid)
      assert.equal(raw.hash, hashData(raw.data))
      const [p] = raw.meta.proofs
      assert.ok(verifyDigest(digestFor(raw.hash, p.custom), p.public, p.result))
    })

    test('credits in an intent never offset its debits', async () => {
      const { sdk, run } = await books()
      const r = await run(issue('alice', 100), transfer('alice', 'bob', 100))
      assert.equal(failed(r).detail, 'Amount -100 is less than minimum allowed amount 0 for wallet alice, symbol usd, schema available')
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 0, reserved: 0 })
    })

    test('an unknown wallet is reported before an unknown symbol', async () => {
      const { run } = await books()
      const r = await run({ action: 'transfer', source: ref('ghost'), target: ref('alice'), symbol: ref('gbp'), amount: 1 })
      assert.equal(failed(r).reason, 'core.routing-failed')
      assert.match(failed(r).detail, /^Source wallet not resolved for the address ghost/)
    })

    test('balances are ordered by symbol, then schema', async () => {
      const { sdk, run } = await books()
      const mine = [{ action: 'any', signer: { public: kp.public } }]
      await sdk.symbol.init().data({ handle: 'eur', factor: 100, access: mine } as any).hash().sign([{ keyPair: kp }]).send()
      await run(issue('alice', 50))
      await run(transfer('alice', 'bob', 10))
      await run(issue('alice', 5, ref('eur')))
      const res: any = await sdk.wallet.getBalances('alice')
      assert.deepEqual(
        res.balances.map((b: any) => `${b.symbol}/${b.schema}`),
        ['eur/available', 'usd/available', 'usd/reserved'],
      )
    })

    test('lists are newest first and paginate with page.index / page.limit', async () => {
      const { sdk } = await books(['w1', 'w2', 'w3'])
      const all: any = await sdk.wallet.list()
      assert.deepEqual(all.wallets.map((w: any) => w.handle), ['w3', 'w2', 'w1'])
      const second: any = await sdk.wallet.list({ page: { index: 1, limit: 2 } } as any)
      assert.deepEqual(second.wallets.map((w: any) => w.handle), ['w1'])
      assert.deepEqual(second.page, { index: 1, limit: 2 })
    })

    test('an intent can be read by its luid', async () => {
      const { sdk, run } = await books()
      const done = await run(issue('alice', 1))
      const byLuid: any = await sdk.intent.read(done.luid)
      assert.equal(byLuid.intent.handle, done.intent.handle)
    })
  })
}
