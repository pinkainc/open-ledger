// Anchors as records (recorded in anchors): an alias for payment details that names an
// existing wallet; a wallet with anchors cannot be dropped.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STORES, failure, newKeyPair, newLedger, startServer, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`anchors on ${storeName}`, () => {
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
      for (const handle of ['alice', 'bob']) await raw(s.wallet.init().data({ handle }).hash().sign([{ keyPair: kp }]).send())
      const anchor = (data: Record<string, unknown>) => raw(s.anchor.init().data(data).hash().sign([{ keyPair: kp }]).send())
      return { s, anchor }
    }

    test('create, read by handle and luid, list by wallet, update with a change history', async () => {
      const { s, anchor } = await books()
      const a = await anchor({ handle: 'tel:1', wallet: 'alice', target: 'alice', symbol: 'usd' })
      await anchor({ handle: 'mail:b', wallet: 'bob', target: { handle: 'acc:1', custom: { bank: 'x' } } })
      assert.match(a.luid, /^\$anc\./)
      assert.equal((await raw(s.anchor.read(a.luid))).data.handle, 'tel:1')
      assert.deepEqual((await raw(s.anchor.list({ 'data.wallet': 'alice' }))).data.map((r: any) => r.data.handle), ['tel:1'])
      const v2 = await raw(s.anchor.from(a).data({ custom: { name: 'A' } }).hash().sign([{ keyPair: kp }]).send())
      assert.equal(v2.data.parent, a.hash)
      const changes = await raw(s.anchor.with('tel:1').change.list())
      assert.deepEqual(changes.data.map((c: any) => [c.meta.change, 'labels' in c.meta]), [[2, false], [1, false]])
    })

    test('an anchor needs `target` and an existing wallet, and no fields beyond the documented', async () => {
      const { anchor } = await books()
      const none = await failure(anchor({ handle: 'x', target: 'y' }))
      assert.deepEqual([none.status, none.reason, none.detail], [422, 'record.relation-not-found', "Cannot find anchor wallet 'undefined'"])
      assert.equal((await failure(anchor({ handle: 'x', wallet: 'ghost', target: 'y' }))).detail, "Cannot find anchor wallet 'ghost'")
      assert.equal((await failure(anchor({ handle: 'x', wallet: 'alice' }))).detail, "Schema validation error: request/body/data must have required property 'target'")
      assert.equal((await failure(anchor({ handle: 'x', wallet: 'alice', target: 'y', colour: 'red' }))).detail, 'Schema validation error: request/body/data must NOT have unevaluated properties')
      await anchor({ handle: 'x', wallet: 'alice', target: 'y' })
      const dup = await failure(anchor({ handle: 'x', wallet: 'bob', target: 'y' }))
      assert.deepEqual([dup.status, dup.detail], [409, 'Anchor with handle x already exists.'])
    })

    test('wallet anchors: the local anchors of the wallet, an unknown wallet has none', async () => {
      const { s, anchor } = await books()
      await anchor({ handle: 'a1', wallet: 'alice', target: 't' })
      await anchor({ handle: 'a2', wallet: 'alice', target: 't' })
      await anchor({ handle: 'b1', wallet: 'bob', target: 't' })
      const list = await raw(s.wallet.getAnchors('alice'))
      assert.deepEqual(list.data.map((r: any) => r.data.handle), ['a2', 'a1'])
      assert.equal('page' in list, false)
      assert.deepEqual((await raw(s.wallet.getAnchors('nobody'))).data, [])
    })

    test('a wallet with anchors cannot be dropped until they are', async () => {
      const { s, anchor } = await books()
      await anchor({ handle: 'b1', wallet: 'bob', target: 't' })
      await anchor({ handle: 'b2', wallet: 'bob', target: 't' })
      const f = await failure(s.wallet.drop('bob').hash().sign([{ keyPair: kp }]).send())
      assert.deepEqual([f.reason, f.detail, f.body.data.custom.anchors], ['record.drop-rejected', "Cannot drop wallet 'bob' with anchors associated with it", ['b1', 'b2']])
      for (const h of ['b1', 'b2']) await s.anchor.drop(h).hash().sign([{ keyPair: kp }]).send()
      assert.equal((await failure(s.anchor.read('b1'))).detail, 'Anchor not found')
      await s.wallet.drop('bob').hash().sign([{ keyPair: kp }]).send()
    })
  })
}
