// Access rules, signer matchers, circles and status policies, as established by the
// access scenarios (FINDINGS, "Access"): rule scope, the ledger `access` gate, and
// the operation named in every 403.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STORES, failure, newKeyPair, newLedger, sdkFor, startServer, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`access on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let a: KeyPair, b: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      a = await newKeyPair()
      b = await newKeyPair()
    })
    after(() => server.close())

    const raw = async (p: Promise<any>) => (await p).response.data
    const only = (k: KeyPair, extra = {}) => ({ action: 'any', signer: { public: k.public }, ...extra })
    const wallet = (sdk: any, k: KeyPair, handle: string, access?: unknown[]) =>
      sdk.wallet.init().data({ handle, ...(access ? { access } : {}) }).hash().sign([{ keyPair: k }]).send()
    const signer = (sdk: any, handle: string, k: KeyPair) =>
      sdk.signer.init().data({ handle, public: k.public, format: 'ed25519-raw' }).hash().sign([{ keyPair: a }]).send()
    /** A status proof on a wallet, signed by `k` through `k`'s own client. */
    async function setStatus(ledger: string, k: KeyPair, handle: string, status: string) {
      const sdk: any = sdkFor(server.base, ledger, k)
      const cur = await raw(sdk.wallet.read(handle))
      return raw(sdk.wallet.from(cur).sign([{ keyPair: k, custom: { status } }]).send())
    }

    test('a 403 names the operation, whether the gate or the rules refused', async () => {
      const { handle } = await newLedger(server.base, a, [only(a), { action: 'read' }])
      // The ledger rule without `record` covers the ledger only: A may not create a symbol.
      const sym = await failure((sdkFor(server.base, handle, a) as any).symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign([{ keyPair: a }]).send())
      assert.deepEqual([sym.status, sym.reason, sym.detail], [403, 'auth.forbidden', 'Cannot create symbol.'])
      const w = await failure(wallet(sdkFor(server.base, handle, b), b, 'mallory'))
      assert.equal(w.detail, 'Cannot create wallet.')
    })

    test('a ledger rule with `record: any` covers the records in it', async () => {
      const { handle } = await newLedger(server.base, a, [only(a, { record: 'any' })])
      await wallet(sdkFor(server.base, handle, a), a, 'alice')
      assert.equal((await failure(wallet(sdkFor(server.base, handle, b), b, 'bob'))).detail, 'Cannot create wallet.')
    })

    test('mutations need `access` on the ledger even where a rule grants the action', async () => {
      const intentOpen = { action: 'create', record: 'wallet' }
      const closed = await newLedger(server.base, a, [only(a, { record: 'any' }), intentOpen])
      assert.equal((await failure(wallet(sdkFor(server.base, closed.handle, b), b, 'bob'))).detail, 'Cannot create wallet.')
      const gated = await newLedger(server.base, a, [only(a, { record: 'any' }), intentOpen, { action: 'access', signer: { public: b.public } }])
      await wallet(sdkFor(server.base, gated.handle, b), b, 'bob')
    })

    test('reads are refused with the operation too', async () => {
      const { handle, sdk } = await newLedger(server.base, a, [only(a, { record: 'any' }), { action: 'read' }])
      await wallet(sdk, a, 'alice')
      const e = await failure(sdkFor(server.base, handle, b).wallet.read('alice'))
      assert.deepEqual([e.status, e.detail], [403, 'Cannot read wallet.'])
    })

    test('a bearer rule matches the token signer, for reads', async () => {
      // Everyone may enter: without `access` the wallet's rule would not help (policies2 #5).
      const { handle, sdk } = await newLedger(server.base, a, [only(a, { record: 'any' }), { action: 'access' }])
      await wallet(sdk, a, 'alice', [{ action: 'read', bearer: { $signer: { public: b.public } } }])
      await sdkFor(server.base, handle, b).wallet.read('alice')
      const other = await newKeyPair()
      assert.equal((await failure(sdkFor(server.base, handle, other).wallet.read('alice'))).status, 403)
    })

    describe('signer matchers on a wallet', () => {
      // Everyone passes the gate and may create; only the wallet's own rule grants updates.
      const open = () => [{ action: 'access' }, { action: 'create', record: 'any' }, { action: 'read', record: 'any' }]

      async function check(matcher: unknown, setup?: (sdk: any, ledger: string) => Promise<void>) {
        const { handle, sdk } = await newLedger(server.base, a, open())
        await setup?.(sdk, handle)
        await wallet(sdk, a, 'w', [{ action: 'any', signer: matcher }])
        return {
          b: () => setStatus(handle, b, 'w', 'inactive'),
          a: () => setStatus(handle, a, 'w', 'inactive'),
        }
      }

      test('`public`', async () => {
        const t = await check({ public: b.public })
        assert.equal((await t.b()).meta.status, 'inactive')
        assert.equal((await failure(t.a())).detail, 'Cannot update wallet.')
      })

      test('`handle` names a signer record of the ledger', async () => {
        const t = await check({ handle: 'bee' }, async (sdk) => void (await signer(sdk, 'bee', b)))
        assert.equal((await t.b()).meta.status, 'inactive')
        assert.equal((await failure(t.a())).status, 403)
      })

      test('`$circle` matches members through circle-signer links', async () => {
        const t = await check({ $circle: 'ops' }, async (sdk) => {
          await signer(sdk, 'bee', b)
          // Assigning a member takes `assign-signer` on the circle, which the ledger does not grant.
          await sdk.circle.init().data({ handle: 'ops', access: [only(a)] }).hash().sign([{ keyPair: a }]).send()
          await sdk.circle.with('ops').signer.init().data({ circle: 'ops', signer: 'bee' }).hash().sign([{ keyPair: a }]).send()
        })
        assert.equal((await t.b()).meta.status, 'inactive')
        assert.equal((await failure(t.a())).status, 403)
      })

      test('`$record: owner` matches the keys that created the record', async () => {
        const t = await check({ $record: 'owner' })
        assert.equal((await t.a()).meta.status, 'inactive')
        assert.equal((await failure(t.b())).status, 403)
      })

      test('`$ledger: owner` matches the keys that created the ledger', async () => {
        const t = await check({ $ledger: 'owner' })
        assert.equal((await t.a()).meta.status, 'inactive')
        assert.equal((await failure(t.b())).status, 403)
      })

      test('`$in` matches any of its matchers', async () => {
        const t = await check({ $in: [{ public: 'nobody' }, { public: b.public }] })
        assert.equal((await t.b()).meta.status, 'inactive')
      })
    })

    test('circle signers: 200 on create, `$csn` luid, listed, read and dropped', async () => {
      const { sdk } = await newLedger(server.base, a)
      const s: any = sdk
      await signer(s, 'bee', b)
      await s.circle.init().data({ handle: 'ops' }).hash().sign([{ keyPair: a }]).send()
      const res = await s.circle.with('ops').signer.init().data({ circle: 'ops', signer: 'bee' }).hash().sign([{ keyPair: a }]).send()
      assert.equal(res.response.status, 200)
      const link = res.response.data
      assert.match(link.luid, /^\$csn\./)
      assert.equal(link.meta.status, undefined)
      assert.equal(link.meta.proofs[0].origin, undefined)
      const listed = await raw(s.circle.with('ops').signer.list())
      assert.deepEqual(listed.data.map((l: any) => l.data.signer), ['bee'])
      assert.equal((await raw(s.circle.with('ops').signer.read(link.luid))).luid, link.luid)
      await s.circle.with('ops').signer.drop(link.luid).hash().sign([{ keyPair: a }]).send()
      assert.deepEqual((await raw(s.circle.with('ops').signer.list())).data, [])
    })

    test('a circle signer must name an existing signer', async () => {
      const { sdk } = await newLedger(server.base, a)
      const s: any = sdk
      await s.circle.init().data({ handle: 'ops' }).hash().sign([{ keyPair: a }]).send()
      const e = await failure(s.circle.with('ops').signer.init().data({ circle: 'ops', signer: 'ghost' }).hash().sign([{ keyPair: a }]).send())
      assert.deepEqual([e.status, e.reason], [404, 'record.not-found'])
    })

    describe('status policies', () => {
      async function withPolicy(values: unknown[]) {
        const { handle, sdk } = await newLedger(server.base, a)
        await wallet(sdk, a, 'w')
        await (sdk as any).policy.init().data({ handle: 'p', schema: 'status', record: 'wallet', values }).hash().sign([{ keyPair: a }]).send()
        return handle
      }

      test('without a policy any status is set', async () => {
        const { handle, sdk } = await newLedger(server.base, a)
        await wallet(sdk, a, 'w')
        assert.equal((await setStatus(handle, a, 'w', 'whatever')).meta.status, 'whatever')
      })

      test('a proof outside the quorum is stored without effect; the quorum sets it', async () => {
        const handle = await withPolicy([{ status: 'active', quorum: [{ public: a.public }] }])
        const byB = await setStatus(handle, b, 'w', 'active')
        assert.equal(byB.meta.status, 'created')
        assert.equal(byB.meta.proofs.at(-1).public, b.public)
        assert.equal((await setStatus(handle, a, 'w', 'active')).meta.status, 'active')
      })

      test('a quorum of two needs both', async () => {
        const handle = await withPolicy([{ status: 'active', quorum: [{ public: a.public }, { public: b.public }] }])
        assert.equal((await setStatus(handle, a, 'w', 'active')).meta.status, 'created')
        assert.equal((await setStatus(handle, b, 'w', 'active')).meta.status, 'active')
      })

      test('a status no value allows is refused and not stored', async () => {
        const handle = await withPolicy([{ status: { $in: ['active'] }, quorum: [] }])
        const e = await failure(setStatus(handle, a, 'w', 'blocked'))
        assert.deepEqual(
          [e.status, e.reason, e.detail],
          [422, 'record.status-policy-violation', 'Cannot set wallet status to blocked. No values correspond to the target status.'],
        )
        const w = await raw(sdkFor(server.base, handle, a).wallet.read('w'))
        assert.equal(w.meta.proofs.length, 2)
        assert.equal((await setStatus(handle, a, 'w', 'active')).meta.status, 'active')
      })
    })

    describe('access policies', () => {
      const readA = { action: 'read', record: 'any', bearer: { $signer: { public: '' } } }
      const policy = (sdk: any, data: Record<string, unknown>) =>
        sdk.policy.init().data({ schema: 'access', ...data }).hash().sign([{ keyPair: a }]).send()
      async function policyStatus(sdk: any, handle: string, status: string) {
        const cur = await raw(sdk.policy.read(handle))
        return sdk.policy.from(cur).sign([{ keyPair: a, custom: { status } }]).send()
      }
      const update = async (ledger: string, k: KeyPair, handle: string) => {
        const cur = await raw(sdkFor(server.base, ledger, a).wallet.read(handle))
        return (sdkFor(server.base, ledger, k) as any).wallet.from(cur).data({ custom: { n: Math.random() } }).hash().sign([{ keyPair: k }]).send()
      }
      async function setup(config?: Record<string, unknown>) {
        const rules = [only(a, { record: 'any' }), { ...readA, bearer: { $signer: { public: a.public } } }, { action: 'access', signer: { public: b.public } }]
        const l = await newLedger(server.base, a, rules, config)
        await signer(l.sdk, 'b', b)
        await (l.sdk as any).circle.init().data({ handle: 'bank' }).hash().sign([{ keyPair: a }]).send()
        await (l.sdk as any).circle.with('bank').signer.init().data({ circle: 'bank', signer: 'b' }).hash().sign([{ keyPair: a }]).send()
        await policy(l.sdk, { handle: 'reader', record: 'any', values: [{ action: 'read', bearer: { $signer: { $circle: 'bank' } } }] })
        await policy(l.sdk, { handle: 'updater', extend: 'reader', record: 'wallet', values: [{ action: 'update', signer: { $circle: 'bank' } }] })
        return l
      }

      test('a `{policy}` rule stands for the values of the policy and of the one it extends', async () => {
        const { handle, sdk } = await setup()
        await wallet(sdk, a, 'w1', [{ policy: 'updater' }, only(a)])
        await wallet(sdk, a, 'w2', [only(a)])
        await wallet(sdk, a, 'w3', [{ policy: 'nope' }, only(a)]) // an unknown policy is accepted, grants nothing
        await sdkFor(server.base, handle, b).wallet.read('w1')
        await update(handle, b, 'w1')
        assert.equal((await failure(update(handle, b, 'w2'))).detail, 'Cannot update wallet.')
        assert.equal((await failure(sdkFor(server.base, handle, b).wallet.read('w3'))).detail, 'Cannot read wallet.')
        // Values default `record` to their policy's; signer and bearer are not shown.
        const check = await raw((sdkFor(server.base, handle, b) as any).wallet.with('w1').access.check().data({ action: 'update' }).hash().sign([{ keyPair: b }]).send())
        assert.deepEqual(check.data.map((r: any) => r.data), [{ action: 'update', record: 'wallet' }])
        // In a record-based ledger the policy's status does not matter.
        await policyStatus(sdk, 'updater', 'inactive')
        await update(handle, b, 'w1')
      })

      test('a policy for wallets does not apply to a symbol that names it', async () => {
        const { handle, sdk } = await setup()
        await (sdk as any).symbol.init().data({ handle: 'usd', factor: 100, access: [{ policy: 'updater' }, only(a)] }).hash().sign([{ keyPair: a }]).send()
        const cur = await raw(sdk.symbol.read('usd'))
        const e = await failure((sdkFor(server.base, handle, b) as any).symbol.from(cur).data({ custom: { n: 1 } }).hash().sign([{ keyPair: b }]).send())
        assert.equal(e.detail, 'Cannot update symbol.')
      })

      test('policy-based: only active policies count, the gate included; record and ledger rules do not', async () => {
        const { handle, sdk } = await setup()
        await policy(sdk, { handle: 'admin', record: 'any', values: [only(a), { action: 'any', bearer: { $signer: { public: a.public } } }] })
        await policyStatus(sdk, 'admin', 'active')
        await policyStatus(sdk, 'updater', 'active')
        await wallet(sdk, a, 'w', [only(a), { action: 'any', signer: { public: b.public } }])
        const cur = await raw(sdk.ledger.read())
        await (sdk as any).ledger.from(cur).data({ config: { 'access.strategy': 'policy-based' } }).hash().sign([{ keyPair: a }]).send()
        // B's ledger `access` rule and the wallet's rule for B no longer count.
        assert.equal((await failure(update(handle, b, 'w'))).detail, 'Cannot update wallet.')
        await policy(sdk, { handle: 'enter', record: 'ledger', values: [{ action: 'access', signer: { $circle: 'bank' } }] })
        await policyStatus(sdk, 'enter', 'active')
        await update(handle, b, 'w')
        // `reader` is not active, but `updater` extends it.
        await sdkFor(server.base, handle, b).wallet.read('w')
        await policyStatus(sdk, 'updater', 'inactive')
        assert.equal((await failure(update(handle, b, 'w'))).detail, 'Cannot update wallet.')
        // The migration is not one-way on the reference; owners are still stored.
        await wallet(sdk, a, 'w4', [only(a)])
        assert.deepEqual((await raw(sdk.wallet.read('w4'))).meta.owners, [a.public])
        const now = await raw(sdk.ledger.read())
        await (sdk as any).ledger.from(now).data({ config: { 'access.strategy': 'record-based' } }).hash().sign([{ keyPair: a }]).send()
        await update(handle, b, 'w')
      })

      // policies3, policies4: a policy-based ledger where K enters and gets only what follows.
      async function policyBased() {
        const k = await newKeyPair()
        const l = await newLedger(server.base, a, [only(a, { record: 'any' }), { ...readA, bearer: { $signer: { public: a.public } } }])
        const active = async (data: Record<string, unknown>) => {
          await policy(l.sdk, { access: [only(a)], ...data })
          await policyStatus(l.sdk, data.handle as string, 'active')
        }
        await active({ handle: 'admin', record: 'any', values: [only(a), { action: 'any', bearer: { $signer: { public: a.public } } }] })
        await active({ handle: 'enter', record: 'ledger', values: [{ action: 'access', signer: { public: k.public } }, { action: 'access', bearer: { $signer: { public: k.public } } }] })
        const cur = await raw(l.sdk.ledger.read())
        await (l.sdk as any).ledger.from(cur).data({ config: { 'access.strategy': 'policy-based' } }).hash().sign([{ keyPair: a }]).send()
        return { ...l, k, asK: sdkFor(server.base, l.handle, k) as any, active }
      }

      test('a policy in a domain holds for that domain only; a list shows what `any` grants', async () => {
        const { sdk, k, asK, active } = await policyBased()
        for (const d of ['payments', 'other']) await (sdk as any).domain.init().data({ handle: d }).hash().sign([{ keyPair: a }]).send()
        await active({ handle: 'pay@payments', record: 'wallet', values: [{ action: 'any', signer: { public: k.public } }, { action: 'read', bearer: { $signer: { public: k.public } } }] })
        await wallet(asK, k, 'k1@payments', [])
        assert.equal((await failure(wallet(asK, k, 'k2@other', []))).detail, 'Cannot create wallet.')
        assert.equal((await failure(wallet(asK, k, 'k3', []))).detail, 'Cannot create wallet.')
        await wallet(sdk, a, 'a2@other', [])
        assert.equal((await failure(asK.wallet.read('a2@other'))).detail, 'Cannot read wallet.')
        assert.deepEqual((await raw(asK.wallet.list())).data.map((w: any) => w.data.handle), ['k1@payments'])
      })

      test('a value\'s filter is relative to data, takes operators, and its keys are checked; lists ignore read values', async () => {
        const { sdk, k, asK, active } = await policyBased()
        for (const [h, schema] of [['usd', 'fiat'], ['btc', 'crypto']]) await (sdk as any).symbol.init().data({ handle: h, factor: 100, custom: { schema } }).hash().sign([{ keyPair: a }]).send()
        await active({ handle: 'fiat', record: 'symbol', values: [{ action: 'read', bearer: { $signer: { public: k.public } }, filter: { 'custom.schema': { $in: ['fiat'] } } }] })
        await asK.symbol.read('usd')
        assert.equal((await failure(asK.symbol.read('btc'))).detail, 'Cannot read symbol.')
        assert.deepEqual((await raw(asK.symbol.list())).data, [])
        const bad = await failure(policy(sdk, { handle: 'bad', record: 'wallet', values: [{ action: 'read', filter: { 'data.handle': 'x' } }] }))
        assert.equal(bad.reason, 'record.schema-invalid')
        assert.match(bad.detail, /^Cannot define access filter key "data.handle" for record "wallet". Allowed keys: \["\^handle\$"/)
      })

      test('invoke: canSpendEveryClaimWallet asks the sources, canReadAnyClaimWallet any wallet, canSpendAllChangedRouteTargets the new routes', async () => {
        const { sdk, k, asK, active } = await policyBased()
        for (const h of ['b1', 'b2', 'b3']) await wallet(sdk, a, h, [])
        await (sdk as any).symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign([{ keyPair: a }]).send()
        await active({ handle: 'k-wallets', record: 'wallet', values: [{ action: 'spend', signer: { public: k.public }, filter: { handle: { $in: ['b1', 'b2'] } } }, { action: 'read', bearer: { $signer: { public: k.public } }, filter: { handle: 'b1' } }] })
        await active({ handle: 'k-intents', record: 'intent', values: [{ action: 'create', signer: { public: k.public }, invoke: 'intent.canSpendEveryClaimWallet' }, { action: 'read', bearer: { $signer: { public: k.public } }, invoke: 'intent.canReadAnyClaimWallet' }] })
        await active({ handle: 'k-create', record: 'wallet', values: [{ action: 'create', signer: { public: k.public }, invoke: 'wallet.canSpendAllChangedRouteTargets' }] })
        const move = (sdkOf: any, key: KeyPair, handle: string, source: string, target: string) =>
          sdkOf.intent.init().data({ handle, claims: [{ action: 'transfer', source: { handle: source }, target: { handle: target }, symbol: { handle: 'usd' }, amount: 1 }] }).hash().sign([{ keyPair: key }]).send()
        await move(asK, k, 'k-13', 'b1', 'b3')
        assert.equal((await failure(move(asK, k, 'k-31', 'b3', 'b1'))).detail, 'Cannot create intent.')
        await move(sdk, a, 'a-12', 'b1', 'b2')
        await move(sdk, a, 'a-23', 'b2', 'b3')
        await asK.intent.read('a-12')
        assert.equal((await failure(asK.intent.read('a-23'))).detail, 'Cannot read intent.')
        await asK.wallet.init().data({ handle: 'r-ok', routes: [{ action: 'forward', target: 'b2' }] }).hash().sign([{ keyPair: k }]).send()
        const refused = await failure(asK.wallet.init().data({ handle: 'r-no', routes: [{ action: 'forward', target: 'b3' }] }).hash().sign([{ keyPair: k }]).send())
        assert.equal(refused.detail, 'Cannot create wallet.')
      })

      test('a read needs `access` unless a ledger rule grants the read itself', async () => {
        const c = await newKeyPair()
        const { handle, sdk } = await newLedger(server.base, a, [only(a, { record: 'any' }), { action: 'access', signer: { public: b.public } }])
        await wallet(sdk, a, 'w', [only(a), { action: 'read', bearer: { $signer: { public: c.public } } }, { action: 'read', bearer: { $signer: { public: b.public } } }])
        assert.equal((await failure(sdkFor(server.base, handle, c).wallet.read('w'))).detail, 'Cannot read wallet.')
        // B's `access` is a signer rule; the token's key satisfies it.
        await sdkFor(server.base, handle, b).wallet.read('w')
        const open = await newLedger(server.base, a, [only(a, { record: 'any' }), { action: 'read', record: 'any' }])
        await wallet(open.sdk, a, 'w', [only(a)])
        await sdkFor(server.base, open.handle, c).wallet.read('w')
      })
    })
  })
}
