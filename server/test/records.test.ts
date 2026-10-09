// Generic record lifecycle, identical for every kind that allows it: update with a
// parent hash, status by proof, change history, drop, access check — plus the
// server signers every ledger publishes.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STORES, failure, newKeyPair, newLedger, ref, sendIntent, settle, setupBooks, startServer, type KeyPair } from './helpers.js'
import { hashData } from '../src/crypto.js'

for (const [storeName, makeStore] of STORES) {
  describe(`records on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let kp: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      kp = await newKeyPair()
    })
    after(() => server.close())

    const raw = async (p: Promise<any>) => (await p).response.data

    test('update links to the parent, keeps luid and status, and is recorded as a change', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await setupBooks(sdk, kp, ['alice'])
      const v1 = await raw(sdk.wallet.read('alice'))
      const v2 = await raw(sdk.wallet.from(v1).data({ custom: { tier: 'gold' } } as any).hash().sign([{ keyPair: kp }]).send())
      assert.equal(v2.data.parent, v1.hash)
      assert.equal(v2.luid, v1.luid)
      assert.equal(v2.meta.status, 'created')
      assert.equal(v2.hash, hashData(v2.data))
      const system = v2.meta.proofs.at(-1)
      assert.deepEqual(Object.keys(system.custom).sort(), ['luid', 'moment'])

      const changes: any = await raw((sdk.wallet as any).with('alice').change.list())
      assert.deepEqual(changes.data.map((c: any) => [c.meta.change, c.meta.action]), [[2, 'update'], [1, 'create']])
      assert.equal(changes.page.total, 2)
      const first: any = await raw((sdk.wallet as any).with('alice').change.read(1))
      assert.equal(first.hash, v1.hash)
    })

    test('an update from a stale parent is 422 crypto.parent-hash-invalid', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await setupBooks(sdk, kp, ['alice'])
      const v1 = await raw(sdk.wallet.read('alice'))
      await sdk.wallet.from(v1).data({ custom: { n: 1 } } as any).hash().sign([{ keyPair: kp }]).send()
      const e = await failure(sdk.wallet.from(v1).data({ custom: { n: 2 } } as any).hash().sign([{ keyPair: kp }]).send())
      assert.deepEqual([e.status, e.reason, e.detail], [422, 'crypto.parent-hash-invalid', "Hash verification failed, hashes don't match"])
    })

    test('a status proof changes the status without a server countersignature', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await setupBooks(sdk, kp, ['alice'])
      const v = await raw(sdk.wallet.read('alice'))
      const out = await raw(sdk.wallet.from(v).sign([{ keyPair: kp, custom: { status: 'inactive' } } as any]).send())
      assert.equal(out.meta.status, 'inactive')
      assert.equal(out.meta.proofs.length, v.meta.proofs.length + 1)
      assert.equal(out.meta.proofs.at(-1).signer, undefined)
      assert.equal(out.hash, v.hash)
    })

    test('drop removes an empty wallet; a funded one is refused', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await setupBooks(sdk, kp, ['alice', 'bob'])
      await sdk.wallet.drop('bob').hash().sign([{ keyPair: kp }]).send()
      assert.equal((await failure(sdk.wallet.read('bob'))).reason, 'record.not-found')
      assert.deepEqual((await raw(sdk.wallet.list())).data.map((w: any) => w.data.handle), ['alice'])

      await settle(sdk, await sendIntent(sdk, kp, [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 1 }]))
      const e = await failure(sdk.wallet.drop('alice').hash().sign([{ keyPair: kp }]).send())
      assert.equal(e.reason, 'record.drop-rejected')
    })

    test('every ledger publishes system, core, system.auth and system.dtc as signers', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const list: any = await raw(sdk.signer.list())
      assert.deepEqual(list.data.map((s: any) => s.data.handle), ['system', 'core', 'system.auth', 'system.dtc'])
      const system = list.data[0]
      assert.match(system.data.secret, /^\{\{ secret\.[a-z]{16} \}\}$/)
      assert.deepEqual(system.data.access, [{ action: 'read' }])
      assert.equal(system.meta.owners[0], system.data.public)
      // The ledger's own proof on every record comes from the published system key.
      const ledger: any = await raw(sdk.ledger.read())
      assert.equal(ledger.meta.proofs.at(-1).public, system.data.public)
    })

    test('signers can be created and read', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const other = await newKeyPair()
      await (sdk.signer as any).init().data({ handle: 'ops', public: other.public, format: 'ed25519-raw' }).hash().sign([{ keyPair: kp }]).send()
      const s: any = await raw(sdk.signer.read('ops'))
      assert.match(s.luid, /^\$snr\./)
      assert.equal(s.data.public, other.public)
    })

    test('access check lists the granting rules for the check signers, without signer', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await setupBooks(sdk, kp, ['alice'])
      const out: any = await raw((sdk.wallet as any).with('alice').access.check().data({ action: 'read' }).hash().sign([{ keyPair: kp }]).send())
      // Ledger rules first; the wallet's `{any, signer: kp}` is shown as `{any, record: wallet}`.
      assert.deepEqual(out.data.map((r: any) => r.data), [{ action: 'any', record: 'any' }, { action: 'any', record: 'wallet' }])
      assert.equal(out.data[0].hash, hashData(out.data[0].data))
      const stranger = await newKeyPair()
      const other: any = await raw((sdk.wallet as any).with('alice').access.check().data({ action: 'read' }).hash().sign([{ keyPair: stranger }]).send())
      assert.deepEqual(other.data.map((r: any) => r.data), [{ action: 'any', record: 'any' }])
    })

    test('the ledger record is updated, signed and checked like any record', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const s: any = sdk
      const v1 = await raw(s.ledger.read())
      const v2 = await raw(s.ledger.from(v1).data({ custom: { region: 'eu' } }).hash().sign([{ keyPair: kp }]).send())
      assert.deepEqual([v2.data.parent, v2.luid, v2.data.custom.region], [v1.hash, v1.luid, 'eu'])
      const v3 = await raw(s.ledger.from(v2).sign([{ keyPair: kp, custom: { status: 'active' } }]).send())
      assert.equal(v3.meta.status, 'active')
      const changes = await raw(s.ledger.change.list())
      assert.deepEqual(changes.data.map((c: any) => [c.meta.change, c.meta.action, c.meta.status]), [[3, 'update', 'active'], [2, 'update', 'created'], [1, 'create', 'created']])
      assert.equal((await raw(s.ledger.change.read(1))).hash, v1.hash)
      const check = await raw(s.ledger.access.check().data({ action: 'read' }).hash().sign([{ keyPair: kp }]).send())
      assert.deepEqual(check.data.map((r: any) => r.data), [{ action: 'any', record: 'any' }])
    })

    test('every ledger has the intent and access-policy status policies', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const list = await raw((sdk as any).policy.list())
      assert.deepEqual(list.data.map((p: any) => p.data.handle), ['intent:status', 'access-policy:status'])
      const p = list.data[0]
      assert.equal(p.meta.status, undefined)
      assert.deepEqual(Object.keys(p.meta.proofs[0]).sort(), ['digest', 'method', 'public', 'result'])
      assert.equal(p.meta.owners[0], p.meta.proofs[1].public)
      assert.equal(p.meta.moment, (await raw(sdk.ledger.read())).meta.moment)
    })

    test('a status policy with a filter applies only to matching records', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const s: any = sdk
      // `access-policy:status` filters on schema: access, so this status policy is free.
      await s.policy.init().data({ handle: 'p', schema: 'status', record: 'wallet', values: [{ status: 'x' }] }).hash().sign([{ keyPair: kp }]).send()
      const p = await raw(s.policy.read('p'))
      assert.equal((await raw(s.policy.from(p).sign([{ keyPair: kp, custom: { status: 'whatever' } }]).send())).meta.status, 'whatever')
    })

    test('an intent is recorded as one change per stage', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await setupBooks(sdk, kp, ['alice'])
      const h = await sendIntent(sdk, kp, [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 1 }])
      await settle(sdk, h)
      const changes = await raw((sdk.intent as any).with(h).change.list())
      assert.deepEqual(
        changes.data.reverse().map((c: any) => [c.meta.change, c.meta.status, c.meta.proofs.length, c.meta.routed ?? false]),
        [[1, 'pending', 3, false], [2, 'pending', 4, false], [3, 'prepared', 5, false], [4, 'prepared', 5, true], [5, 'committed', 6, true], [6, 'committed', 7, true], [7, 'completed', 8, true]],
      )
    })

    test('a further signature on an intent is appended; owners and status stay', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await setupBooks(sdk, kp, ['alice'])
      const h = await sendIntent(sdk, kp, [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 1 }])
      await settle(sdk, h)
      const done = await raw(sdk.intent.read(h))
      const other = await newKeyPair()
      const out = await raw((sdk.intent as any).from(done).sign([{ keyPair: other }]).send())
      assert.equal(out.meta.proofs.length, done.meta.proofs.length + 1)
      assert.deepEqual([out.meta.status, out.meta.owners], [done.meta.status, done.meta.owners])
      assert.equal(out.meta.proofs.at(-1).public, other.public)
    })

    test('bridges and policies drop like wallets; a bridge a wallet names cannot be dropped (recorded, drops)', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const s: any = sdk
      const make = (client: string, data: Record<string, unknown>) => raw(s[client].init().data(data).hash().sign([{ keyPair: kp }]).send())
      const bridge = { schema: 'rest', config: { server: 'http://127.0.0.1:9/v2' }, secure: [] }
      await make('bridge', { handle: 'idle', ...bridge })
      await make('bridge', { handle: 'used', ...bridge })
      await make('wallet', { handle: 'acc', bridge: 'used' })
      await s.bridge.drop('idle').hash().sign([{ keyPair: kp }]).send()
      assert.equal((await failure(s.bridge.read('idle'))).detail, 'Bridge not found')
      const f = await failure(s.bridge.drop('used').hash().sign([{ keyPair: kp }]).send())
      assert.deepEqual([f.status, f.reason, f.detail], [422, 'record.drop-rejected', 'Bridge used is in use by wallets. Please remove it from the wallets first.'])
      await s.policy.drop('intent:status').hash().sign([{ keyPair: kp }]).send()
      assert.equal((await failure(s.policy.read('intent:status'))).detail, 'Policy not found')
    })
  })
}
