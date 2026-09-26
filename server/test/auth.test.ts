// Token impersonation: when a token's key belongs to a signer record, `system.auth`
// signs mutations on that signer's behalf (about-authentication; observed in access3).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey } from 'node:crypto'
import { SignJWT } from 'jose'
import { STORES, newKeyPair, newLedger, startServer, type KeyPair } from './helpers.js'
import { digestFor, hashData, signDigest, verifyDigest } from '../src/crypto.js'

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')

/** A self-signed EdDSA token as the SDK makes one, for requests sent without the SDK. */
async function token(kp: KeyPair, ledger: string) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secret, 'base64')]), format: 'der', type: 'pkcs8' })
  return new SignJWT({ iss: kp.public, sub: `signer:${kp.public}`, aud: ledger })
    .setProtectedHeader({ alg: 'EdDSA', kid: kp.public })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key)
}

for (const [storeName, makeStore] of STORES) {
  describe(`token impersonation on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let owner: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      owner = await newKeyPair()
    })
    after(() => server.close())

    const raw = async (p: Promise<any>) => (await p).response.data

    async function ledgerWithSigner(handle = 'a') {
      const { handle: ledger, sdk } = await newLedger(server.base, owner)
      await (sdk.signer as any).init().data({ handle, public: owner.public, format: 'ed25519-raw' }).hash().sign([{ keyPair: owner }]).send()
      const auth: any = await raw(sdk.signer.read('system.auth'))
      return { ledger, sdk, authKey: auth.data.public as string }
    }

    const post = async (path: string, ledger: string, body: unknown, bearer?: string) => {
      const res = await fetch(`${server.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ledger': ledger, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as any }
    }

    test('a signed request with a registered signer token gains a system.auth proof and owner', async () => {
      const { sdk, ledger, authKey } = await ledgerWithSigner()
      const w: any = await raw(sdk.wallet.init().data({ handle: 'alice' }).hash().sign([{ keyPair: owner }]).send())
      const [client, imp, system] = w.meta.proofs
      assert.equal(client.origin, 'key-pair')
      assert.equal(client.signer, 'a')
      assert.deepEqual([imp.origin, imp.signer, imp.issuer, imp.public], ['self-signed-token', 'a', 'a', authKey])
      assert.equal(imp.custom.status, 'created')
      assert.equal(imp.custom['bearer.aud'], ledger)
      assert.equal(imp.custom['bearer.sub'], `signer:${owner.public}`)
      assert.equal(imp.custom['bearer.exp'] - imp.custom['bearer.iat'], 3600)
      assert.equal(imp.digest, digestFor(w.hash, imp.custom))
      assert.ok(verifyDigest(imp.digest, imp.public, imp.result))
      assert.equal(system.signer, 'system')
      assert.deepEqual(w.meta.owners, [owner.public, authKey])
    })

    test('a token whose key is no signer record impersonates nothing', async () => {
      const { sdk } = await newLedger(server.base, owner)
      const w: any = await raw(sdk.wallet.init().data({ handle: 'alice' }).hash().sign([{ keyPair: owner }]).send())
      assert.deepEqual(w.meta.proofs.map((p: any) => p.origin), ['key-pair', 'key-pair'])
      assert.deepEqual(w.meta.owners, [owner.public])
    })

    test('a token alone authenticates a create: the ledger hashes and signs it', async () => {
      const { ledger, authKey } = await ledgerWithSigner()
      const res = await post('/wallets', ledger, { data: { handle: 'bob' } }, await token(owner, ledger))
      assert.equal(res.status, 201)
      assert.equal(res.body.hash, hashData({ handle: 'bob' }))
      assert.deepEqual(res.body.meta.proofs.map((p: any) => [p.origin, p.signer]), [['self-signed-token', 'a'], ['key-pair', 'system']])
      assert.deepEqual(res.body.meta.owners, [authKey])
    })

    test('without a registered signer a token alone is not a signature', async () => {
      const { handle: ledger } = await newLedger(server.base, owner)
      const res = await post('/wallets', ledger, { data: { handle: 'bob' } }, await token(owner, ledger))
      assert.deepEqual([res.status, res.body.data.reason], [422, 'crypto.signature-missing'])
    })

    test('partial proofs are templates whose custom the impersonated proof carries', async () => {
      const { ledger } = await ledgerWithSigner()
      const res = await post('/wallets', ledger, { data: { handle: 'carol' }, meta: { proofs: [{ custom: { status: 'active', note: 'x' } }] } }, await token(owner, ledger))
      assert.equal(res.status, 201)
      const imp = res.body.meta.proofs[0]
      assert.deepEqual([imp.custom.status, imp.custom.note, imp.origin], ['active', 'x', 'self-signed-token'])
    })

    test('a partial status proof is impersonated on the proofs endpoint', async () => {
      const { sdk, ledger } = await ledgerWithSigner()
      await sdk.wallet.init().data({ handle: 'dan', access: [{ action: 'any', signer: { public: owner.public } }] } as any).hash().sign([{ keyPair: owner }]).send()
      const res = await post('/wallets/dan/proofs', ledger, { custom: { status: 'inactive' } }, await token(owner, ledger))
      assert.equal(res.status, 200)
      assert.equal(res.body.meta.status, 'inactive')
      assert.equal(res.body.meta.proofs.at(-1).origin, 'self-signed-token')
    })

    test('a client cannot claim an impersonated origin or another signer', async () => {
      const { handle: ledger } = await newLedger(server.base, owner)
      const data = { handle: 'eve' }
      const hash = hashData(data)
      const custom = { moment: new Date().toISOString(), status: 'created' }
      const digest = digestFor(hash, custom)
      const proof = { method: 'ed25519-v2', public: owner.public, digest, result: signDigest(digest, { ...owner, format: 'ed25519-raw' }), custom, origin: 'self-signed-token', signer: 'system', issuer: 'x' }
      const res = await post('/wallets', ledger, { hash, data, meta: { proofs: [proof] } }, await token(owner, ledger))
      assert.equal(res.status, 201)
      const stored = res.body.meta.proofs[0]
      assert.deepEqual([stored.origin, stored.signer, stored.issuer], ['key-pair', undefined, undefined])
    })

    test('an impersonated request is authorised as the token signer, not as system.auth', async () => {
      const onlyOwner = [{ action: 'any', signer: { public: owner.public }, record: 'any' }, { action: 'read', record: 'any' }]
      const { handle: ledger, sdk } = await newLedger(server.base, owner, onlyOwner)
      const other = await newKeyPair()
      for (const [h, k] of [['a', owner], ['b', other]] as const)
        await (sdk.signer as any).init().data({ handle: h, public: k.public, format: 'ed25519-raw' }).hash().sign([{ keyPair: owner }]).send()
      assert.equal((await post('/wallets', ledger, { data: { handle: 'gus' } }, await token(owner, ledger))).status, 201)
      const refused = await post('/wallets', ledger, { data: { handle: 'hal' } }, await token(other, ledger))
      assert.deepEqual([refused.status, refused.body.data.reason], [403, 'auth.forbidden'])
    })
  })
}
