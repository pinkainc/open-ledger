// The ledger collection, ledger drop and the request journal (recorded in `ledgers`).
// The reference has drop and journaling switched off, so what they do when on is ours
// and only tested here: `ledgerDrop` and `journal` (AppOptions).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, signHash, signJWT } from '@minka/ledger-sdk/crypto'
import { Core } from '../src/core.js'
import { describe as describeRequest, redact } from '../src/journal.js'
import { STORES, failure, newKeyPair, newLedger, sdkFor, startServer, type KeyPair } from './helpers.js'

describe('journal entries', () => {
  test('record and action follow the SDK names', () => {
    const cases: [string, string, string, string][] = [
      ['POST', '/api/v2/wallets', 'wallet', 'create'],
      ['GET', '/api/v2/wallets?data.handle=a', 'wallet', 'query'],
      ['GET', '/api/v2/wallets/w1', 'wallet:w1', 'read'],
      ['PUT', '/api/v2/wallets/w1', 'wallet:w1', 'update'],
      ['DELETE', '/api/v2/wallets/w1', 'wallet:w1', 'drop'],
      ['POST', '/api/v2/wallets/w1/drop', 'wallet:w1', 'drop'],
      ['GET', '/api/v2/wallets/w1/balances', 'wallet:w1', 'read-balance'],
      ['POST', '/api/v2/intents/i1/proofs', 'intent-proof:i1', 'create'],
      ['GET', '/api/v2/intents/i1/changes', 'intent-change:i1', 'query'],
      ['GET', '/api/v2/intents/i1/changes/2', 'intent-change:i1', 'read'],
      ['POST', '/api/v2/bridges/b/access/!check', 'bridge-access:b', 'check'],
      ['GET', '/api/v2/ledger', 'ledger', 'read'],
      ['PUT', '/api/v2/ledger', 'ledger', 'update'],
      ['POST', '/api/v2/ledger/proofs', 'ledger-proof', 'create'],
      ['GET', '/api/v2/signers/s/factors/f', 'signer-factor:f', 'read'],
      ['GET', '/api/v2/circles/c/signers', 'circle-signer:c', 'query-signer'],
    ]
    for (const [method, url, record, action] of cases) assert.deepEqual(describeRequest(method, url), { record, action }, `${method} ${url}`)
  })

  test('the bearer token is redacted, whatever its case', () => {
    assert.deepEqual(redact({ Authorization: 'Bearer x', 'x-ledger': 'l' }), { Authorization: '[REDACTED]', 'x-ledger': 'l' })
    assert.deepEqual(redact({ authorization: 'Bearer x' }), { authorization: '[REDACTED]' })
  })
})

for (const [storeName, makeStore] of STORES) {
  const call = async (base: string, method: string, path: string, opts: { ledger?: string; key?: KeyPair; body?: unknown } = {}) => {
    const headers: Record<string, string> = {}
    if (opts.key) {
      const iat = Math.floor(Date.now() / 1000)
      headers.authorization = `Bearer ${await signJWT({ iat, exp: iat + 300, iss: opts.key.public, aud: opts.ledger ?? 'x', sub: `signer:${opts.key.public}` }, opts.key.secret, opts.key.public)}`
    }
    if (opts.ledger) headers['x-ledger'] = opts.ledger
    if (opts.body) headers['content-type'] = 'application/json'
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
    const text = await res.text()
    let body: any = text
    try {
      body = JSON.parse(text)
    } catch {}
    return { status: res.status, body }
  }
  const dropBody = async (luid: string, parent: string, keys: KeyPair[]) => {
    const data = { parent }
    const hash = createHash(data)
    return { luid, hash, data, meta: { proofs: await Promise.all(keys.map((k) => signHash(hash, k, { moment: new Date().toISOString(), status: 'dropped' }))) } }
  }

  describe(`ledgers on ${storeName}, defaults (as the reference)`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let owner: KeyPair
    let stranger: KeyPair
    before(async () => {
      const store = await makeStore()
      server = await startServer(store, new Core(store))
      owner = await newKeyPair()
      stranger = await newKeyPair()
    })
    after(() => server.close())

    test('a signer lists the ledgers it owns, newest first; a stranger none; anonymous callers are refused', async () => {
      const a = (await newLedger(server.base, owner)).handle
      const b = (await newLedger(server.base, owner)).handle
      const listed = await call(server.base, 'GET', '/ledgers', { key: owner })
      assert.equal(listed.status, 200)
      const handles = listed.body.data.map((l: any) => l.data.handle)
      assert.ok(handles.indexOf(b) < handles.indexOf(a) && handles.indexOf(b) >= 0)
      assert.deepEqual((await call(server.base, 'GET', '/ledgers', { key: stranger })).body.data, [])
      assert.equal((await call(server.base, 'GET', '/ledgers')).body.data.detail, 'Cannot query ledger.')
      assert.equal((await call(server.base, 'GET', '/ledgers', { key: owner, ledger: a })).body.data.reason, 'api.no-tenant-allowed')
    })

    test('drop is validated, then not routed; POST /ledger is not routed at all', async () => {
      const l = (await newLedger(server.base, owner)).handle
      const read: any = await sdkFor(server.base, l, owner).ledger.read()
      const gone = await call(server.base, 'DELETE', '/ledger', { ledger: l, key: owner, body: await dropBody(read.luid, read.hash, [owner]) })
      assert.equal(gone.status, 404)
      assert.equal(gone.body.data.detail, 'Route not found')
      const noLuid = await call(server.base, 'DELETE', '/ledger', { ledger: l, key: owner, body: { ...(await dropBody(read.luid, read.hash, [owner])), luid: undefined } })
      assert.equal(noLuid.body.data.reason, 'record.schema-invalid')
      const post = await call(server.base, 'POST', '/ledger', { ledger: l, key: owner, body: await dropBody(read.luid, read.hash, [owner]) })
      assert.equal(post.status, 404)
      assert.match(post.body, /Cannot POST \/v2\/ledger/)
      assert.equal((await call(server.base, 'DELETE', '/ledger', { body: {} })).body.data.detail, 'Active ledger is not set!')
    })

    test('the journal is off', async () => {
      const l = (await newLedger(server.base, owner)).handle
      assert.equal((await call(server.base, 'GET', '/system/requests', { ledger: l, key: owner })).body.data.detail, 'Journaling is not enabled')
      assert.equal((await call(server.base, 'GET', '/system/requests')).body.data.detail, 'Active ledger is not set!')
    })

    test('a list keeps only the records the caller may read', async () => {
      const l = (await newLedger(server.base, owner, [{ action: 'access', record: 'ledger' }, { action: 'create', record: 'wallet' }])).handle
      const sdk: any = sdkFor(server.base, l, owner)
      await sdk.wallet.init().data({ handle: 'open', access: [{ action: 'read' }] }).hash().sign([{ keyPair: owner }]).send()
      await sdk.wallet.init().data({ handle: 'closed', access: [{ action: 'read', signer: { public: owner.public } }] }).hash().sign([{ keyPair: owner }]).send()
      const seen = (await call(server.base, 'GET', '/wallets', { ledger: l, key: stranger })).body.data.map((w: any) => w.data.handle)
      assert.deepEqual(seen, ['open'])
    })
  })

  describe(`ledgers on ${storeName}, with drop and journal on`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let owner: KeyPair
    let stranger: KeyPair
    before(async () => {
      const store = await makeStore()
      server = await startServer(store, new Core(store), { ledgerDrop: true, journal: true })
      owner = await newKeyPair()
      stranger = await newKeyPair()
    })
    after(() => server.close())

    test('an owner drops a ledger: everything of it is gone and the handle is free again', async () => {
      const l = (await newLedger(server.base, owner, [{ action: 'any', signer: { public: owner.public } }])).handle
      const sdk: any = sdkFor(server.base, l, owner)
      const read: any = await sdk.ledger.read()
      const refused = await call(server.base, 'DELETE', '/ledger', { ledger: l, key: stranger, body: await dropBody(read.luid, read.hash, [stranger]) })
      assert.equal(refused.status, 403)
      const stale = await call(server.base, 'DELETE', '/ledger', { ledger: l, key: owner, body: await dropBody(read.luid, '0'.repeat(64), [owner]) })
      assert.equal(stale.body.data.reason, 'crypto.parent-hash-invalid')
      assert.equal((await call(server.base, 'POST', '/ledger', { ledger: l, key: owner, body: await dropBody(read.luid, read.hash, [owner]) })).status, 204)
      assert.equal((await failure(sdk.ledger.read())).detail, 'Server does not host requested ledger')
      const listed = (await call(server.base, 'GET', '/ledgers', { key: owner })).body.data.map((x: any) => x.data.handle)
      assert.ok(!listed.includes(l))
      // The SDK's own drop (DELETE) on a recreated ledger of the same handle.
      await sdkFor(server.base, undefined, owner, l).ledger.init().data({ handle: l, signer: 'system', access: [{ action: 'any', signer: { public: owner.public } }] } as any).hash().sign([{ keyPair: owner }]).send()
      assert.deepEqual((await sdk.wallet.list()).wallets, [])
      await sdk.ledger.drop().hash().sign([{ keyPair: owner }]).send()
      assert.equal((await failure(sdk.ledger.read())).status, 404)
    })

    test('the journal keeps each request of a ledger, token redacted, and filters like any list', async () => {
      const l = (await newLedger(server.base, owner)).handle
      const sdk: any = sdkFor(server.base, l, owner)
      await sdk.wallet.init().data({ handle: 'w1' }).hash().sign([{ keyPair: owner }]).send()
      await sdk.wallet.read('w1')
      const page = await call(server.base, 'GET', '/system/requests?data.record=wallet:w1', { ledger: l, key: owner })
      assert.equal(page.status, 200)
      assert.equal(page.body.data.length, 1)
      const entry = page.body.data[0]
      assert.match(entry.luid, /^\$req\./)
      assert.equal(entry.data.action, 'read')
      assert.equal(entry.data.target, `ledger:${l}`)
      assert.equal(entry.data.source, `signer:${owner.public}`)
      assert.equal(entry.data.params.headers.authorization, '[REDACTED]')
      assert.equal(entry.data.result.status, 200)
      assert.equal(JSON.parse(entry.data.result.body).data.handle, 'w1')
      const created = await call(server.base, 'GET', '/system/requests?data.action=create', { ledger: l, key: owner })
      assert.deepEqual(created.body.data.map((e: any) => e.data.record), ['wallet'])
      const one = await call(server.base, 'GET', `/system/requests/${entry.data.handle}`, { ledger: l, key: owner })
      assert.equal(one.body.luid, entry.luid)
      assert.equal((await call(server.base, 'GET', `/system/requests/${entry.luid}`, { ledger: l, key: owner })).body.hash, entry.hash)
      assert.equal((await call(server.base, 'GET', '/system/requests/nope', { ledger: l, key: owner })).status, 404)
      // Reading the journal is not journaled.
      const all = await call(server.base, 'GET', '/system/requests', { ledger: l, key: owner })
      assert.ok(all.body.data.every((e: any) => !e.data.params.url.includes('/system/requests')))
    })

    test('a ledger that keeps the journal from strangers', async () => {
      const l = (await newLedger(server.base, owner, [{ action: 'any', signer: { public: owner.public } }])).handle
      assert.equal((await call(server.base, 'GET', '/system/requests', { ledger: l, key: stranger })).status, 403)
    })
  })
}
