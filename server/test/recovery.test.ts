// Failure modes that unit-level behaviour tests do not reach: a process that dies with
// intents still pending or in the middle of the credit phase, two processes sharing one Postgres, a transaction that throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Core } from '../src/core.js'
import { PgStore } from '../src/pg-store.js'
import { MemoryStore, type Store } from '../src/store.js'
import { STORES, balanceOf, newKeyPair, newLedger, ref, sendIntent, settle, setupBooks, sdkFor, testBridge, until } from './helpers.js'

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

// The credit phase is one transaction: the `Store.once` mark and the credits' delivery
// records. A process that dies after it commits, before the calls leave, has set the
// mark, so the intent's own step never sends the credits again; the next start sends
// the delivery records that are still pending, each once.
for (const [storeName, makeStore] of STORES) {
  test(`a process that dies in the credit phase: the next start sends each credit once (${storeName})`, async (t) => {
    const store = await makeStore()
    const b1 = await testBridge()
    const b2 = await testBridge()
    const [kp, k1, k2] = [await newKeyPair(), await newKeyPair(), await newKeyPair()]
    const cleanup: (() => unknown)[] = [() => b1.close(), () => b2.close(), () => (store as any).close?.()]
    t.after(async () => { for (const f of cleanup.reverse()) await f() })
    // The first process sends everything but the credits: it dies before they leave.
    const first = new Core(store)
    const deliver = first.bridges.deliver.bind(first.bridges)
    first.bridges.deliver = async (call) => (/\/credits$/.test(call.path) ? false : deliver(call))
    const dying = await serve(store, first)
    cleanup.push(() => first.close(), () => dying.app.close())
    const { sdk, handle } = await newLedger(dying.base, kp)
    const s: any = sdk
    const sign = [{ keyPair: kp }]
    await s.bridge.init().data({ handle: 'bank1', schema: 'rest', config: { server: b1.url }, secure: [] }).hash().sign(sign).send()
    await s.bridge.init().data({ handle: 'bank2', schema: 'rest', config: { server: b2.url }, secure: [] }).hash().sign(sign).send()
    await s.signer.init().data({ handle: 'bank1', public: k1.public, format: 'ed25519-raw' }).hash().sign(sign).send()
    await s.signer.init().data({ handle: 'bank2', public: k2.public, format: 'ed25519-raw' }).hash().sign(sign).send()
    await s.symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign(sign).send()
    await s.wallet.init().data({ handle: 'a1', bridge: 'bank1' }).hash().sign(sign).send()
    await s.wallet.init().data({ handle: 'b2', bridge: 'bank2' }).hash().sign(sign).send()
    await settle(s, await sendIntent(s, kp, [{ action: 'issue', target: ref('a1'), symbol: usd, amount: 50 }]))
    const prepares = (b: typeof b1, h: string) => b.calls.filter((c) => /\/(debits|credits)$/.test(c.url) && c.body.data.intent.data.handle === h)
    const report = (base: string, key: typeof kp, intent: any, custom: Record<string, unknown>) =>
      (sdkFor(base, handle, key) as any).intent.from(intent).sign([{ keyPair: key, custom }]).send()

    const h = await sendIntent(s, kp, [{ action: 'transfer', source: ref('a1'), target: ref('b2'), symbol: usd, amount: 20 }])
    const debit = await until(() => prepares(b1, h)[0], 'debit prepare')
    await report(dying.base, k1, debit.body.data.intent, { handle: debit.body.data.handle, status: 'prepared' })
    const pending = await until(async () => {
      const ds = (await store.list(handle, 'events')).filter((d) => d.meta.output?.data?.intent?.data?.handle === h && d.meta.output.data.schema === 'credit')
      return ds.length ? ds : undefined
    }, 'the credit delivery record')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].meta.status, 'pending')
    assert.equal(prepares(b2, h).length, 0, 'the credit never left')
    first.close()
    await dying.app.close()

    // The next start: the intent is stepped again and the pending delivery re-sent.
    const core = new Core(store)
    const alive = await serve(store, core)
    cleanup.push(() => core.close(), () => alive.app.close())
    await core.resume()
    const credit = await until(() => prepares(b2, h)[0], 'credit prepare after the restart')
    assert.equal(credit.body.data.handle, pending[0].meta.output.data.handle, 'the recorded credit, unchanged')
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(prepares(b2, h).length, 1, 'sent once')

    await report(alive.base, k2, credit.body.data.intent, { handle: credit.body.data.handle, status: 'prepared' })
    const c1 = await until(() => b1.calls.find((c) => c.url.endsWith('/commit') && c.body.data.intent.data.handle === h), 'commit to bank1')
    const c2 = await until(() => b2.calls.find((c) => c.url.endsWith('/commit') && c.body.data.intent.data.handle === h), 'commit to bank2')
    await report(alive.base, k1, c1.body.data.intent, { handle: debit.body.data.handle, status: 'committed' })
    await report(alive.base, k2, c2.body.data.intent, { handle: credit.body.data.handle, status: 'committed' })
    const live = sdkFor(alive.base, handle, kp)
    assert.equal((await settle(live, h)).meta.status, 'completed')
    assert.equal(prepares(b2, h).length, 1)
    assert.deepEqual(await balanceOf(live, 'a1'), { available: 30, reserved: 0 })
  })
}

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
