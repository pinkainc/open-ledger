// `filter` on processing policies (recorded, forwarding2): the context is `new`, a value's
// filter replaces its policy's, and values whose filter misses do not count as several.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { aspectFor } from '../src/forwarding.js'
import { MemoryStore } from '../src/store.js'

const L = 'l'
const aspect = (strategy: string, filter?: unknown) => ({ schema: 'aspect', action: 'create', invoke: { bridge: 'dir' }, config: { strategy }, ...(filter ? { filter } : {}) })
async function ledger(filter: unknown, values: unknown[]) {
  const store = new MemoryStore()
  await store.insert(L, 'bridges', { hash: 'b', data: { handle: 'dir' }, luid: '$brg.b', meta: { proofs: [], moment: 'm', owners: [] } })
  await store.insert(L, 'policies', { hash: 'p', data: { handle: 'p', schema: 'processing', record: 'anchor', ...(filter ? { filter } : {}), values }, luid: '$pol.p', meta: { proofs: [], moment: 'm', owners: [] } })
  return store
}
const sent = (rail: string) => ({ new: { data: { handle: 'a', custom: { rail } } } })
const strategyFor = async (store: MemoryStore, rail: string) => (await aspectFor(store, L, 'create', sent(rail)))?.strategy

describe('processing policy filters', () => {
  test('root filter on `new`; `data.` matches nothing', async () => {
    const store = await ledger({ 'new.data.custom.rail': 'r1' }, [aspect('proxy')])
    assert.equal(await strategyFor(store, 'r1'), 'proxy')
    assert.equal(await strategyFor(store, 'r2'), undefined)
    assert.equal(await strategyFor(await ledger({ 'data.custom.rail': 'r1' }, [aspect('proxy')]), 'r1'), undefined)
  })
  test("a value's filter replaces the root's", async () => {
    const store = await ledger({ 'new.data.custom.rail': 'r1' }, [aspect('proxy', { 'new.data.custom.rail': 'r2' })])
    assert.equal(await strategyFor(store, 'r1'), undefined)
    assert.equal(await strategyFor(store, 'r2'), 'proxy')
  })
  test('filters pick one of several values', async () => {
    const store = await ledger(undefined, [aspect('proxy', { 'new.data.custom.rail': 'r1' }), aspect('validate', { 'new.data.custom.rail': 'r2' })])
    assert.equal(await strategyFor(store, 'r1'), 'proxy')
    assert.equal(await strategyFor(store, 'r2'), 'validate')
    assert.equal(await strategyFor(store, 'r3'), undefined)
  })
})
