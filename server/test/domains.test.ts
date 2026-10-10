// Domains (recorded in domains): records join one at creation, by a proof's
// `custom.domain` or a one-`@` handle suffix; intents list their wallets' domains.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STORES, failure, newKeyPair, newLedger, ref, sdkFor, settle, startServer, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`domains on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let kp: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      kp = await newKeyPair()
    })
    after(() => server.close())

    const raw = async (p: Promise<any>) => (await p).response.data
    async function books() {
      const { sdk } = await newLedger(server.base, kp)
      const s: any = sdk
      const make = (client: string, data: Record<string, unknown>, custom?: Record<string, unknown>) =>
        raw(s[client].init().data(data).hash().sign([{ keyPair: kp, ...(custom ? { custom } : {}) }]).send())
      return { s, make }
    }

    test('a handle suffix needs domains to exist first; then it names one', async () => {
      const { make } = await books()
      const early = await make('wallet', { handle: 'a@payments' })
      assert.equal('domain' in early.meta, false)
      const d = await make('domain', { handle: 'payments' })
      assert.match(d.luid, /^\$dom\./)
      assert.equal((await make('wallet', { handle: 'treasury@payments' })).meta.domain, 'payments')
      assert.equal('domain' in (await make('wallet', { handle: 'w@x@payments' })).meta, false)
      const f = await failure(make('wallet', { handle: 'x@nowhere' }))
      assert.deepEqual([f.status, f.reason, f.detail, f.body.data.custom], [422, 'record.relation-not-found', 'Trying to set a domain which doesn\'t exist "nowhere" to the record "x@nowhere"', { domain: 'nowhere' }])
    })

    test("a proof's custom.domain wins over the handle; a subdomain records its parent in data", async () => {
      const { make } = await books()
      await make('domain', { handle: 'payments' })
      await make('domain', { handle: 'retail' }, { domain: 'payments' })
      const sub = await make('domain', { handle: 'eu@payments' })
      assert.deepEqual([Object.keys(sub.data), sub.data.domain, sub.meta.domain], [['handle', 'domain'], 'payments', 'payments'])
      assert.equal((await make('wallet', { handle: 'acc@payments' }, { domain: 'retail' })).meta.domain, 'retail')
      assert.equal((await make('symbol', { handle: 'eur@payments', factor: 100 })).meta.domain, 'payments')
    })

    test('lists filter by meta.domain, except domains', async () => {
      const { s, make } = await books()
      await make('domain', { handle: 'payments' })
      await make('wallet', { handle: 'a@payments' })
      await make('wallet', { handle: 'b' })
      assert.deepEqual((await raw(s.wallet.list({ 'meta.domain': 'payments' }))).data.map((w: any) => w.data.handle), ['a@payments'])
      const f = await failure(raw(s.domain.list({ 'meta.domain': 'payments' })))
      assert.deepEqual([f.status, f.reason, f.detail], [400, 'api.query-malformed', "Unsupported filters: 'meta.domain'"])
      assert.equal((await failure(make('domain', { handle: 'x', colour: 'red' }))).detail, 'Schema validation error: request/body/data must NOT have unevaluated properties')
    })

    test("an intent's meta.domains are its wallets' domains", async () => {
      const { s, make } = await books()
      await make('domain', { handle: 'payments' })
      await make('domain', { handle: 'retail' })
      await make('symbol', { handle: 'usd', factor: 100 })
      for (const handle of ['t@payments', 'r@retail', 'plain']) await make('wallet', { handle })
      const issue = await make('intent', { handle: 'i1', claims: [{ action: 'issue', target: ref('t@payments'), symbol: ref('usd'), amount: 10 }] })
      assert.deepEqual(issue.meta.domains, ['payments'])
      await settle(s, 'i1')
      const t = (from: string, to: string) => ({ action: 'transfer', source: ref(from), target: ref(to), symbol: ref('usd'), amount: 1 })
      const cross = await make('intent', { handle: 'i2', claims: [t('t@payments', 'plain'), t('t@payments', 'r@retail')] })
      assert.deepEqual(cross.meta.domains, ['payments', 'retail'])
      assert.deepEqual((await raw(s.intent.list({ 'meta.domains': 'retail' }))).data.map((i: any) => i.data.handle), ['i2'])
    })
    // Recorded in domains2: a restrictive ledger where only domains grant anything.
    test('a domain grants to records in it and its subdomains, not upward, and not new subdomains', async () => {
      const [A, C] = [await newKeyPair(), await newKeyPair()]
      const op = { action: 'any', signer: { public: kp.public } }
      const { sdk, handle } = await newLedger(server.base, kp, [op, { ...op, record: 'any' }, { action: 'access' }, { action: 'read', record: 'any', bearer: { $signer: { public: kp.public } } }])
      const s: any = sdk
      const as = (k: KeyPair): any => sdkFor(server.base, handle, k)
      const make = (k: KeyPair, client: string, data: Record<string, unknown>, domain?: string) =>
        raw(as(k)[client].init().data(data).hash().sign([{ keyPair: k, ...(domain ? { custom: { domain } } : {}) }]).send())
      await make(kp, 'domain', { handle: 'a', access: [op, { action: 'any', record: 'any', signer: { public: A.public } }, { action: 'read', record: 'any', bearer: { $signer: { public: A.public } } }] })
      await make(kp, 'domain', { handle: 'c@a', access: [op, { action: 'any', record: 'any', signer: { public: C.public } }] })
      assert.equal((await make(A, 'wallet', { handle: 'wa@a' })).meta.domain, 'a')
      assert.equal((await make(A, 'wallet', { handle: 'wc' }, 'c@a')).meta.domain, 'c@a')
      await make(C, 'wallet', { handle: 'wc3' }, 'c@a')
      for (const [k, data, domain] of [[A, { handle: 'root' }], [A, { handle: 'w@c@a' }], [C, { handle: 'wa-c@a' }]] as const)
        assert.equal((await failure(make(k, 'wallet', data, domain))).detail, 'Cannot create wallet.')
      assert.equal((await failure(make(A, 'domain', { handle: 'd@a' }))).detail, 'Cannot create domain.')
      // Updates and reads: the record grants nothing, its domains do; C's signer rule lets C read.
      const wc3 = (await raw(s.wallet.read('wc3')))
      assert.equal((await raw(as(A).wallet.from(wc3).data({ custom: { by: 'A' } }).hash().sign([{ keyPair: A }]).send())).data.custom.by, 'A')
      assert.equal((await failure(as(C).wallet.from(await raw(s.wallet.read('wa@a'))).data({ custom: {} }).hash().sign([{ keyPair: C }]).send())).status, 403)
      assert.equal((await raw(as(C).wallet.read('wc3'))).data.handle, 'wc3')
      assert.equal((await failure(as(C).wallet.read('wa@a'))).detail, 'Cannot read wallet.')
      // A list leaves out what the caller may not read.
      const handles = async (k: any) => (await raw(k.wallet.list())).data.map((w: any) => w.data.handle).sort()
      assert.deepEqual(await handles(as(A)), ['wa@a', 'wc', 'wc3'])
      assert.deepEqual(await handles(as(C)), ['wc', 'wc3'])
      // An intent joins the domain its proof names.
      const i = await raw(as(A).intent.init().data({ handle: 'i-a', claims: [{ action: 'issue', target: ref('wa@a'), symbol: ref('usd'), amount: 1 }] }).hash().sign([{ keyPair: A, custom: { domain: 'a' } }]).send())
      assert.equal(i.meta.domain, 'a')
    })
  })
}
