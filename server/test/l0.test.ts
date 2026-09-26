import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { failure, newKeyPair, newLedger, sdkFor, startServer, type KeyPair } from './helpers.js'
import { hashData, verifyDigest } from '../src/crypto.js'

let server: Awaited<ReturnType<typeof startServer>>
let kp: KeyPair
before(async () => {
  server = await startServer()
  kp = await newKeyPair()
})
after(() => server.close())

const wallet = (sdk: any, handle: string, keyPair: KeyPair) =>
  sdk.wallet.init().data({ handle, access: [{ action: 'any', signer: { public: keyPair.public } }] }).hash().sign([{ keyPair }]).send()

test('create and read back a wallet; server proof binds the luid', async () => {
  const { sdk } = await newLedger(server.base, kp)
  const created = await wallet(sdk, 'alice', kp)
  const { wallet: w } = await sdk.wallet.read('alice')
  assert.equal(w.handle, 'alice')
  const res: any = created
  const luid = res.luid ?? res.response?.data?.luid
  assert.match(luid, /^\$wlt\.-[\w-]{16}$/)
})

test('duplicate handle is 409 record.duplicated', async () => {
  const { sdk } = await newLedger(server.base, kp)
  await wallet(sdk, 'bob', kp)
  const e = await failure(wallet(sdk, 'bob', kp))
  assert.equal(e.status, 409)
  assert.equal(e.reason, 'record.duplicated')
  assert.equal(e.detail, 'Wallet with handle bob already exists.')
})

test('each ledger has its own system signer, and it signs errors inside the ledger', async () => {
  const a = await newLedger(server.base, kp)
  const b = await newLedger(server.base, kp)
  const ea = await failure(a.sdk.wallet.read('nobody'))
  const eb = await failure(b.sdk.wallet.read('nobody'))
  const [pa] = ea.body.meta.proofs, [pb] = eb.body.meta.proofs
  assert.notEqual(pa.public, pb.public)
  assert.equal(hashData(ea.body.data), ea.body.hash)
  assert.ok(verifyDigest(pa.digest, pa.public, pa.result))
})

test('unknown ledger is an unsigned 404 api.route-not-found', async () => {
  const e = await failure(sdkFor(server.base, 'no-such-ledger', kp).ledger.read())
  assert.equal(e.status, 404)
  assert.equal(e.reason, 'api.route-not-found')
  assert.deepEqual(e.body.meta.proofs, [])
})

// A `signer` rule is matched against proof signers, so it grants mutations only;
// reads are granted by `bearer` rules, matched against the token.
test('an open rule lets anonymous reads through; bearer rules gate reads by token', async () => {
  const open = await newLedger(server.base, kp)
  await sdkFor(server.base, open.handle).ledger.read()

  const closed = await newLedger(server.base, kp, [
    { action: 'any', signer: { public: kp.public } },
    { action: 'read', bearer: { $signer: { public: kp.public } } },
  ])
  const e = await failure(sdkFor(server.base, closed.handle).ledger.read())
  assert.equal(e.status, 403)
  assert.equal(e.reason, 'auth.forbidden')

  const stranger = await newKeyPair()
  const e2 = await failure(sdkFor(server.base, closed.handle, stranger).ledger.read())
  assert.equal(e2.status, 403)
  await closed.sdk.ledger.read()
})

test('a mutation without proofs is 422 crypto.signature-missing', async () => {
  const { sdk } = await newLedger(server.base, kp)
  const e = await failure(sdk.wallet.init().data({ handle: 'x' } as any).hash().send())
  assert.equal(e.status, 422)
  assert.equal(e.reason, 'crypto.signature-missing')
})

test('schema violations name the missing property', async () => {
  const { sdk } = await newLedger(server.base, kp)
  const e = await failure(sdk.symbol.init().data({ handle: 'eur' } as any).hash().sign([{ keyPair: kp }]).send())
  assert.equal(e.status, 422)
  assert.equal(e.reason, 'record.schema-invalid')
  assert.equal(e.detail, "Schema validation error: request/body/data must have required property 'factor'")
})

test('a malformed token is 401 even where anonymous access would pass', async () => {
  const { handle } = await newLedger(server.base, kp)
  const { LedgerSdk } = await import('@minka/ledger-sdk')
  const e = await failure(new LedgerSdk({ server: server.base, ledger: handle, secure: { overrideToken: 'x' } as any }).ledger.read())
  assert.equal(e.status, 401)
  assert.equal(e.reason, 'auth.unauthorized')
})
