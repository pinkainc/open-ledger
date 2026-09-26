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
      const { handle, sdk } = await newLedger(server.base, a, [only(a, { record: 'any' })])
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
        const handle = await withPolicy([{ status: { $in: ['active'] } }])
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
  })
}
