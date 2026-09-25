// One contract, every store. Postgres runs when DATABASE_URL is set
// (scripts/dev-db.sh start prints one); otherwise only the memory store is tested.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, type Store } from '../src/store.js'
import { PgStore } from '../src/pg-store.js'
import { generateKeyPair } from '../src/crypto.js'

const stores: [string, () => Promise<Store & { close?: () => Promise<void> }>][] = [['memory', async () => new MemoryStore()]]
if (process.env.DATABASE_URL) stores.push(['postgres', () => PgStore.connect(process.env.DATABASE_URL!)])

const rec = (handle: string, n = 0) => ({ hash: 'h' + n, data: { handle, n }, luid: `$wlt.-${handle}-${n}-${Math.random()}`, meta: { status: 'created' } })

for (const [name, make] of stores) {
  describe(`store: ${name}`, async () => {
    const store = await make()
    const ledger = `L-${Date.now()}-${Math.random()}`
    after(() => store.close?.())

    test('insert then get returns the record unchanged', async () => {
      const r = rec('alice')
      assert.equal(await store.insert(ledger, 'wallets', r), true)
      assert.deepEqual(await store.get(ledger, 'wallets', 'alice'), r)
    })

    test('a second insert with the same handle is refused', async () => {
      assert.equal(await store.insert(ledger, 'wallets', rec('bob', 1)), true)
      assert.equal(await store.insert(ledger, 'wallets', rec('bob', 2)), false)
      assert.equal((await store.get(ledger, 'wallets', 'bob'))!.data.n, 1)
    })

    test('handles are scoped by ledger and kind', async () => {
      assert.equal(await store.insert(ledger, 'symbols', rec('alice')), true)
      assert.equal(await store.insert(ledger + 'x', 'wallets', rec('alice')), true)
      assert.equal(await store.get(ledger, 'symbols', 'nobody'), undefined)
    })

    test('list keeps insertion order', async () => {
      const l = ledger + '-order'
      for (const h of ['c', 'a', 'b']) await store.insert(l, 'wallets', rec(h))
      assert.deepEqual((await store.list(l, 'wallets')).map((r) => r.data.handle), ['c', 'a', 'b'])
    })

    test('ledger keys round trip', async () => {
      const k = generateKeyPair()
      await store.putKey(ledger, k)
      assert.deepEqual(await store.getKey(ledger), k)
      assert.equal(await store.getKey(ledger + '-none'), undefined)
    })

    test('concurrent inserts of one handle: exactly one wins', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.insert(ledger, 'wallets', rec('race', i))))
      assert.equal(results.filter(Boolean).length, 1)
    })
  })
}
