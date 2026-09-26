// Failure modes that unit-level behaviour tests do not reach: a process that dies with
// intents still pending, two processes sharing one Postgres, a transaction that throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Core } from '../src/core.js'
import { PgStore } from '../src/pg-store.js'
import { MemoryStore, type Store } from '../src/store.js'
import { balanceOf, newKeyPair, newLedger, ref, sendIntent, settle, setupBooks, sdkFor } from './helpers.js'

const usd = ref('usd')

// A Core that accepts work and never does it: the process "died" after answering.
class DeadCore extends Core {
  override schedule() {}
}

async function serve(store: Store, core: Core) {
  const app = buildApp({ store, core })
  await app.listen({ port: 0, host: '127.0.0.1' })
  return { app, base: `http://127.0.0.1:${(app.server.address() as any).port}/api/v2` }
}

test('intents left pending by a dead process are completed on the next start', async () => {
  const store = new MemoryStore()
  const kp = await newKeyPair()
  const dead = await serve(store, new DeadCore(store))
  const { sdk, handle } = await newLedger(dead.base, kp)
  await setupBooks(sdk, kp, ['alice'])
  const h = await sendIntent(sdk, kp, [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 7 }])
  assert.equal((await sdk.intent.read(h) as any).meta.status, 'pending')
  await dead.app.close()

  const core = new Core(store)
  const alive = await serve(store, core)
  await core.resume()
  const live = sdkFor(alive.base, handle, kp)
  assert.equal((await settle(live, h)).meta.status, 'completed')
  assert.equal((await balanceOf(live, 'alice')).available, 7)
  await alive.app.close()
})

test('processing an intent twice is a no-op the second time', async () => {
  const store = new MemoryStore()
  const kp = await newKeyPair()
  const core = new Core(store)
  const s = await serve(store, core)
  const { sdk, handle } = await newLedger(s.base, kp)
  await setupBooks(sdk, kp, ['alice'])
  const h = await sendIntent(sdk, kp, [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 3 }])
  await settle(sdk, h)
  const before = (await sdk.intent.read(h) as any).meta.proofs.length
  await core.process(handle, h)
  assert.equal((await sdk.intent.read(h) as any).meta.proofs.length, before)
  assert.equal((await balanceOf(sdk, 'alice')).available, 3)
  await s.app.close()
})

const url = process.env.DATABASE_URL

test('two processes on one Postgres never overdraw', { skip: !url && 'DATABASE_URL not set' }, async () => {
  const [sa, sb] = [await PgStore.connect(url!), await PgStore.connect(url!)]
  const a = await serve(sa, new Core(sa))
  const b = await serve(sb, new Core(sb))
  const kp = await newKeyPair()
  const { sdk, handle } = await newLedger(a.base, kp)
  await setupBooks(sdk, kp, ['alice', 'bob'])
  await settle(sdk, await sendIntent(sdk, kp, [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 500 }]))

  const viaB = sdkFor(b.base, handle, kp)
  const handles = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      sendIntent(i % 2 ? viaB : sdk, kp, [{ action: 'transfer', source: ref('alice'), target: ref('bob'), symbol: usd, amount: 100 }]),
    ),
  )
  const results = await Promise.all(handles.map((h) => settle(sdk, h, 30_000)))
  assert.equal(results.filter((r) => r.meta.status === 'completed').length, 5)
  assert.deepEqual(await balanceOf(sdk, 'alice'), { available: 0, reserved: 0 })
  assert.deepEqual(await balanceOf(sdk, 'bob'), { available: 500, reserved: 0 })
  await a.app.close(), await b.app.close(), await sa.close(), await sb.close()
})

test('a Postgres transaction that throws leaves nothing behind', { skip: !url && 'DATABASE_URL not set' }, async () => {
  const store = await PgStore.connect(url!)
  const ledger = `rollback-${Date.now()}`
  const row = { hash: '', data: { wallet: 'w', symbol: 'usd', schema: 'available' as const, amount: 1 }, luid: `$wbl.-${Date.now()}`, meta: { moment: 'm' } }
  await assert.rejects(
    store.transaction(ledger, async (tx) => {
      await tx.putBalance(ledger, row)
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.deepEqual(await store.balances(ledger, 'w'), [])
  await store.close()
})
