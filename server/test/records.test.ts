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

    test('access check lists the rules that grant the action', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await setupBooks(sdk, kp, ['alice'])
      const out: any = await raw((sdk.wallet as any).with('alice').access.check().data({ action: 'read' }).hash().sign([{ keyPair: kp }]).send())
      // The owner's `{any, signer}` rule does not grant reads: signer rules are for mutations.
      assert.deepEqual(out.data.map((r: any) => r.data), [{ action: 'any', record: 'any' }])
      assert.equal(out.data[0].hash, hashData(out.data[0].data))
    })
  })
}
