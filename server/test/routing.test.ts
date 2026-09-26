// Addresses and wallet routes (recorded in `routes`): hierarchy, filters, and what an
// intent does with credit, debit, accept and forward routes.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { filterMatches, hierarchy } from '../src/routing.js'
import { STORES, balanceOf, newKeyPair, newLedger, ref, settle, startServer, type KeyPair } from './helpers.js'

describe('address hierarchy', () => {
  test('schema:handle@parent → schema@parent → parent → schema', () => {
    assert.deepEqual(hierarchy('account:1050000029@hpb'), ['account:1050000029@hpb', 'account@hpb', 'hpb', 'account'])
    assert.deepEqual(hierarchy('tel:15261234578'), ['tel:15261234578', 'tel'])
    assert.deepEqual(hierarchy('41111339@zaba'), ['41111339@zaba', 'zaba'])
    assert.deepEqual(hierarchy('alice'), ['alice'])
  })

  test('route filters match claim paths, the intent under ctx, and operators', () => {
    const claim = { action: 'transfer', symbol: { handle: 'eur' }, amount: 5 }
    const intent = { data: { schema: 'p2p' } }
    assert.ok(filterMatches(undefined, claim, intent))
    assert.ok(filterMatches({ 'symbol.handle': 'eur' }, claim, intent))
    assert.ok(!filterMatches({ 'symbol.handle': 'usd' }, claim, intent))
    assert.ok(filterMatches({ 'symbol.handle': 'eur', 'ctx.intent.data.schema': 'p2p' }, claim, intent))
    assert.ok(filterMatches({ amount: { $gt: 4 } }, claim, intent))
    assert.ok(!filterMatches({ amount: { $gt: 5 } }, claim, intent))
    assert.ok(filterMatches({ 'symbol.handle': { $in: ['usd', 'eur'] } }, claim, intent))
  })
})

for (const [storeName, makeStore] of STORES) {
  describe(`routes on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let kp: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      kp = await newKeyPair()
    })
    after(() => server.close())

    const raw = async (p: Promise<any>) => (await p).response.data
    let seq = 0
    const t = (source: string, target: string, amount: number, symbol = 'usd') => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref(symbol), amount })

    async function books(wallets: Record<string, unknown[] | undefined>) {
      const { sdk } = await newLedger(server.base, kp)
      const s: any = sdk
      const sign = [{ keyPair: kp }]
      for (const sym of ['usd', 'eur']) await s.symbol.init().data({ handle: sym, factor: 100 }).hash().sign(sign).send()
      for (const [w, routes] of Object.entries({ alice: undefined, bob: undefined, ...wallets }))
        await s.wallet.init().data({ handle: w, ...(routes ? { routes } : {}) }).hash().sign(sign).send()
      await run(s, [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 100 }, { action: 'issue', target: ref('alice'), symbol: ref('eur'), amount: 100 }])
      return s
    }
    async function run(sdk: any, claims: unknown[]) {
      const handle = `r-${++seq}`
      await sdk.intent.init().data({ handle, claims }).hash().sign([{ keyPair: kp }]).send()
      return settle(sdk, handle)
    }
    const resolvedWallets = (i: any) => i.meta.proofs.filter((p: any) => p.custom.status === 'resolved').map((p: any) => `${p.custom.schema}:${p.custom.wallet}`)
    const failure = (i: any) => i.meta.proofs.find((p: any) => p.custom.status === 'failed')?.custom

    test('an address resolves up its hierarchy; spend is checked on the resolved wallet', async () => {
      const sdk = await books({ tel: undefined, 'loan@hpb': undefined, hpb: undefined })
      assert.deepEqual(resolvedWallets(await run(sdk, [t('alice', 'tel:15261234578', 5)])), ['debit:alice', 'credit:tel'])
      assert.deepEqual(resolvedWallets(await run(sdk, [t('alice', 'loan:42@hpb', 3)])), ['debit:alice', 'credit:loan@hpb'])
      assert.deepEqual(resolvedWallets(await run(sdk, [t('alice', 'account:1@hpb', 7)])), ['debit:alice', 'credit:hpb'])
      const back = await run(sdk, [t('account:9@hpb', 'bob', 2)])
      assert.equal(back.meta.status, 'completed')
      assert.deepEqual(resolvedWallets(back), ['debit:hpb', 'credit:bob'])
      const lost = await run(sdk, [t('alice', '41111339@zaba', 1)])
      assert.equal(failure(lost).detail, 'Target wallet not resolved for the address 41111339@zaba - does not resolve to any existing wallet. Parent wallet: 41111339@zaba')
    })

    test('credit and debit routes move another wallet; accept filters; unmatched routes refuse', async () => {
      const sdk = await books({
        collector: [{ action: 'credit', target: 'bob' }],
        payer: [{ action: 'debit', target: 'alice' }],
        'eur-only': [{ action: 'accept', filter: { 'symbol.handle': 'eur' } }],
        'eur-out': [{ action: 'debit', target: 'eur-out', filter: { 'symbol.handle': 'eur' } }],
      })
      assert.deepEqual(resolvedWallets(await run(sdk, [t('alice', 'collector', 6)])), ['debit:alice', 'credit:bob'])
      assert.deepEqual(resolvedWallets(await run(sdk, [t('payer', 'bob', 4)])), ['debit:alice', 'credit:bob'])
      assert.deepEqual(await balanceOf(sdk, 'bob'), { available: 10, reserved: 0 })

      const usd = await run(sdk, [t('alice', 'eur-only', 1)])
      assert.deepEqual([usd.meta.status, failure(usd).reason, failure(usd).detail], ['rejected', 'core.routing-failed', `No matching out route found for intent ${usd.intent.handle}.`])
      assert.equal((await run(sdk, [t('alice', 'eur-only', 1, 'eur')])).meta.status, 'completed')
      const out = await run(sdk, [t('eur-out', 'bob', 1)])
      assert.equal(failure(out).detail, `No matching in route found for intent ${out.intent.handle}.`)
    })

    test('a routing cycle is refused', async () => {
      const sdk = await books({ cyc2: [{ action: 'credit', target: 'cyc1' }], cyc1: [{ action: 'credit', target: 'cyc2' }] })
      const i = await run(sdk, [t('alice', 'cyc1', 1)])
      assert.deepEqual([i.meta.status, failure(i).detail], ['rejected', 'Credit routing cycle detected for the address cyc1.'])
      assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 100, reserved: 0 })
    })

    test('forward passes the credit on in a new intent of the same thread, made by the ledger', async () => {
      const sdk = await books({ fwd: [{ action: 'forward', target: 'bob' }] })
      const first = await run(sdk, [t('alice', 'fwd', 8)])
      assert.equal(first.meta.status, 'completed')
      const { intents } = await sdk.intent.list()
      const spawned = intents.find((i: any) => i.origin === first.intent.handle)
      assert.ok(spawned, 'a forwarded intent exists')
      assert.match(spawned.handle, /^[0-9A-Za-z]{17}$/)
      const second = await settle(sdk, spawned.handle)
      assert.equal(second.meta.status, 'completed')
      assert.equal(second.meta.thread, first.meta.thread)
      assert.deepEqual(second.intent.claims, [{ action: 'transfer', amount: 8, source: { handle: 'fwd' }, symbol: { handle: 'usd' }, target: { handle: 'bob' } }])
      // Signed by the ledger; the core takes no part (no reservation).
      assert.deepEqual(second.meta.proofs.map((p: any) => `${p.signer ?? '-'}:${p.custom.status}`), [
        '-:created', 'system:pending', 'system:pending', 'system:resolved', 'system:resolved', 'system:prepared', 'system:committed', 'system:committed', 'system:completed',
      ])
      assert.deepEqual(await balanceOf(sdk, 'fwd'), { available: 0, reserved: 0 })
      assert.deepEqual(await balanceOf(sdk, 'bob'), { available: 8, reserved: 0 })
      const fwdRows = (await raw(sdk.wallet.getBalances('fwd'))).data
      assert.deepEqual(fwdRows.map((r: any) => [r.data.schema, r.data.parent]), [['available', '']])
    })
  })
}
