// L9: two of our servers joined by bridges/ledger-bridge (recorded on the sandbox in
// l9). Server A is the clearing house, with wallet `mint` bridged; server B is the
// bank's core. The invariant: B's supply always equals A's `mint` balance, and nothing
// stays in B's `transit` once every intent has finished.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Core } from '../src/core.js'
import { hashData, serverProof } from '../src/crypto.js'
import { LedgerBridge } from '../../bridges/ledger-bridge/src/index.js'
import { STORES, balanceOf, newKeyPair, newLedger, ref, sdkFor, settle, startServer, type KeyPair } from './helpers.js'

const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref('usd'), amount })
const ACCOUNTS = ['account:1', 'account:2', 'account:3']

for (const [storeName, makeStore] of STORES) {
  describe(`L9 two ledgers on ${storeName}`, () => {
    let a: Awaited<ReturnType<typeof startServer>>, b: Awaited<ReturnType<typeof startServer>>
    let kp: KeyPair, mintKey: KeyPair
    const bridges: LedgerBridge[] = []
    before(async () => {
      const sa = await makeStore()
      const sb = await makeStore()
      a = await startServer(sa, new Core(sa, { bridges: { retryMs: 20 } }))
      b = await startServer(sb, new Core(sb))
      kp = await newKeyPair()
      mintKey = await newKeyPair()
    })
    after(async () => {
      for (const x of bridges) await x.close()
      await a.close()
      await b.close()
    })

    async function pair() {
      const A = await newLedger(a.base, kp)
      const B = await newLedger(b.base, kp)
      const bridge = new LedgerBridge({ handle: 'mint', keyPair: mintKey, upstream: { server: a.base, ledger: A.handle }, downstream: { server: b.base, ledger: B.handle }, wallet: 'mint' })
      bridges.push(bridge)
      const port = await bridge.listen(0)
      const sa: any = A.sdk, sb: any = B.sdk
      const both = [{ action: 'any', signer: { public: kp.public } }, { action: 'any', signer: { public: mintKey.public } }]
      const make = (sdk: any, kind: string, data: any) => sdk[kind].init().data(data).hash().sign([{ keyPair: kp }]).send()
      await make(sa, 'bridge', { handle: 'mint', schema: 'rest', config: { server: `http://127.0.0.1:${port}/v2` }, secure: [] })
      await make(sa, 'signer', { handle: 'mint', public: mintKey.public, format: 'ed25519-raw' })
      await make(sa, 'symbol', { handle: 'usd', factor: 100 })
      for (const w of ['ach', 'tesla']) await make(sa, 'wallet', { handle: w })
      await make(sa, 'wallet', { handle: 'mint', bridge: 'mint' })
      await make(sa, 'wallet', { handle: 'tel:1', routes: [{ action: 'forward', target: 'account:1@mint' }] })
      await make(sb, 'symbol', { handle: 'usd', factor: 100, access: both })
      for (const w of ['treasury', 'transit', ...ACCOUNTS]) await make(sb, 'wallet', { handle: w, access: both })
      return { A: sa, B: sb, bridge }
    }

    let seq = 0
    async function pay(sdk: any, claims: unknown[]) {
      const handle = `x-${++seq}`
      await sdk.intent.init().data({ handle, claims }).hash().sign([{ keyPair: kp }]).send()
      return (await settle(sdk, handle, 20_000)).meta.status as string
    }
    async function supply(B: any) {
      let n = 0
      for (const w of ['treasury', 'transit', ...ACCOUNTS]) n += (await balanceOf(B, w)).available
      return n
    }

    test('money crosses both ways; the bank supply mirrors the clearing balance', async () => {
      const { A, B, bridge } = await pair()
      assert.equal(await pay(A, [{ action: 'issue', target: ref('ach'), symbol: ref('usd'), amount: 1000 }, { action: 'issue', target: ref('tesla'), symbol: ref('usd'), amount: 200 }]), 'completed')
      assert.equal(await pay(A, [t('ach', 'mint', 500)]), 'completed')
      await bridge.idle()
      assert.equal((await balanceOf(B, 'treasury')).available, 500)
      assert.equal(await pay(B, [t('treasury', 'account:1', 100)]), 'completed')
      assert.equal(await pay(A, [t('account:1@mint', 'tesla', 30)]), 'completed')
      assert.equal(await pay(A, [t('tesla', 'account:2@mint', 12)]), 'completed')
      assert.equal(await pay(A, [t('account:2@mint', 'tesla', 50)]), 'rejected')
      assert.equal(await pay(A, [t('tesla', 'account:404@mint', 5)]), 'rejected')
      // The debit is held downstream, then given back when the credit fails.
      assert.equal(await pay(A, [t('account:1@mint', 'tesla', 10), t('tesla', 'account:404@mint', 1)]), 'rejected')
      await pay(A, [t('tesla', 'tel:1', 7)])
      for (let i = 0; i < 200 && (await balanceOf(B, 'account:1')).available !== 77; i++) await new Promise((r) => setTimeout(r, 20))
      await bridge.idle()
      assert.equal((await balanceOf(B, 'account:1')).available, 77)
      assert.equal((await balanceOf(B, 'account:2')).available, 12)
      assert.equal((await balanceOf(B, 'transit')).available, 0)
      assert.equal((await balanceOf(A, 'mint')).available, 489)
      assert.equal(await supply(B), 489)
      assert.equal((await balanceOf(A, 'tesla')).available, 211)
    })

    test('the clearing ledger limits the bank to its position before asking it', async () => {
      const { A, bridge } = await pair()
      const handle = `x-${++seq}`
      await A.intent.init().data({ handle, claims: [t('account:3@mint', 'tesla', 1)] }).hash().sign([{ keyPair: kp }]).send()
      const r = await settle(A, handle, 20_000)
      await bridge.idle()
      const failed = r.meta.proofs.find((p: any) => p.custom?.status === 'failed')
      assert.equal(failed?.custom.reason, 'core.limit-exceeded')
      assert.match(failed?.custom.detail, /for wallet mint,/)
    })

    test('a rejected prepare names the bank reason', async () => {
      const { A, bridge } = await pair()
      await pay(A, [{ action: 'issue', target: ref('mint'), symbol: ref('usd'), amount: 5 }])
      await bridge.idle()
      const handle = `x-${++seq}`
      await A.intent.init().data({ handle, claims: [t('account:3@mint', 'tesla', 1)] }).hash().sign([{ keyPair: kp }]).send()
      const r = await settle(A, handle, 20_000)
      await bridge.idle()
      assert.equal(r.meta.status, 'rejected')
      const failed = r.meta.proofs.find((p: any) => p.custom?.status === 'failed' && p.custom?.reason?.startsWith('bridge.'))
      assert.equal(failed?.custom.reason, 'bridge.account-insufficient-balance')
    })

    test('concurrent random payments keep the mirror exact', async () => {
      const { A, B, bridge } = await pair()
      await pay(A, [{ action: 'issue', target: ref('ach'), symbol: ref('usd'), amount: 10_000 }])
      await pay(A, [t('ach', 'mint', 600)])
      await bridge.idle()
      for (const acc of ACCOUNTS) await pay(B, [t('treasury', acc, 200)])
      let rnd = 7
      const next = (n: number) => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31), rnd % n)
      const batch = Array.from({ length: 24 }, () => {
        const acc = `${ACCOUNTS[next(3)]}@mint`
        const amount = 1 + next(120)
        return next(2) ? [t(acc, 'ach', amount)] : [t('ach', acc, amount)]
      })
      const results = await Promise.all(batch.map((claims) => pay(A, claims)))
      assert.ok(results.includes('completed'))
      await bridge.idle()
      assert.equal((await balanceOf(B, 'transit')).available, 0)
      assert.equal(await supply(B), (await balanceOf(A, 'mint')).available)
      for (const acc of ACCOUNTS) assert.ok((await balanceOf(B, acc)).available >= 0)
    })

    test('a call the clearing ledger did not sign is refused', async () => {
      const { bridge } = await pair()
      const port = (bridge as any).server.address().port
      const forger = await newKeyPair()
      const data = { handle: 'cre_forgedforgedforge', schema: 'credit', target: ref('account:1@mint'), symbol: ref('usd'), amount: 1_000_000, intent: {} }
      const hash = hashData(data)
      const res = await fetch(`http://127.0.0.1:${port}/v2/credits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, hash, meta: { proofs: [serverProof(hash, {}, forger as any, 'system')] } }) })
      assert.equal(res.status, 401)
    })

    test('a commit after a restart finds its entry in the intent', async () => {
      const { A } = await pair()
      await pay(A, [{ action: 'issue', target: ref('ach'), symbol: ref('usd'), amount: 100 }])
      const handle = `x-${++seq}`
      await A.intent.init().data({ handle, claims: [t('ach', 'account:2@mint', 9)] }).hash().sign([{ keyPair: kp }]).send()
      const intent = (await A.intent.read(handle)).response.data
      await settle(A, handle, 20_000)
      const done = (await A.intent.read(handle)).response.data
      const credit = done.meta.proofs.find((p: any) => p.custom?.schema === 'credit')?.custom
      const fresh = new LedgerBridge({ handle: 'mint', keyPair: mintKey, upstream: { server: a.base, ledger: '' }, downstream: { server: b.base, ledger: '' }, wallet: 'mint' })
      const entry = fresh.entry(credit.handle, 'credit', done)
      assert.deepEqual({ ...entry, intent: undefined }, { handle: credit.handle, schema: 'credit', amount: 9, symbol: ref('usd'), target: ref('account:2@mint'), intent: undefined })
      assert.ok(intent)
    })
  })
}
