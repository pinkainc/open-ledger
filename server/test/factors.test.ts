// Authentication, second pass (recorded in `factors`, `oauth`, `hsh`): signer factors,
// OAuth 2.0 client credentials, the `hsh` claim, and the bridges' OAuth2 token cache.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey } from 'node:crypto'
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose'
import { LedgerSdk } from '@minka/ledger-sdk'
import { createRsaKeyPair } from '@minka/ledger-sdk/crypto'
import { OAuth2Tokens, lifetimeMs } from '../src/oauth2.js'
import { hashData } from '../src/crypto.js'
import { STORES, failure, newKeyPair, newLedger, startServer, type KeyPair } from './helpers.js'

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const edKey = (kp: KeyPair) => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secret, 'base64')]), format: 'der', type: 'pkcs8' })

describe('OAuth2 token cache for bridges', () => {
  const rule = { clientId: 'c', clientSecret: 's', tokenUrl: 'http://idp/token' }
  const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`
  function endpoint(answer: () => object) {
    const asked: string[] = []
    const f = (async (_url: string, init: any) => {
      asked.push(String(init.body))
      return new Response(JSON.stringify(answer()), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { f, asked }
  }

  test('lifetime: JWT exp first, then expires_in; a JWT without either lives for ever, anything else once', () => {
    assert.equal(lifetimeMs(jwt({ exp: 1100 }), 5, 1_000_000), 100_000)
    assert.equal(lifetimeMs('opaque', 120, 0), 120_000)
    assert.equal(lifetimeMs(jwt({ sub: 'x' }), undefined, 0), Infinity)
    assert.equal(lifetimeMs('opaque', undefined, 0), 0)
  })

  test('a token with expires_in ≥ 60 s is reused until 30 s before it expires', async () => {
    let now = 0
    let n = 0
    const { f, asked } = endpoint(() => ({ access_token: `t${++n}`, expires_in: 120 }))
    const tokens = new OAuth2Tokens(f, () => now)
    assert.equal(await tokens.token(rule), 't1')
    now = 89_000
    assert.equal(await tokens.token(rule), 't1')
    now = 90_000
    assert.equal(await tokens.token(rule), 't2')
    assert.equal(asked.length, 2)
  })

  test('short-lived and opaque tokens without expiry are fetched every time', async () => {
    let n = 0
    const short = endpoint(() => ({ access_token: `s${++n}`, expires_in: 59 }))
    const a = new OAuth2Tokens(short.f, () => 0)
    await a.token(rule)
    await a.token(rule)
    assert.equal(short.asked.length, 2)
    const opaque = endpoint(() => ({ access_token: 'o' }))
    const b = new OAuth2Tokens(opaque.f, () => 0)
    await b.token(rule)
    await b.token(rule)
    assert.equal(opaque.asked.length, 2)
  })

  test('a different secret or scope asks anew', async () => {
    const { f, asked } = endpoint(() => ({ access_token: 't', expires_in: 3600 }))
    const tokens = new OAuth2Tokens(f, () => 0)
    await tokens.token(rule)
    await tokens.token({ ...rule, clientSecret: 'rotated' })
    await tokens.token({ ...rule, scope: 'ledger' })
    await tokens.token(rule)
    assert.deepEqual(asked, ['grant_type=client_credentials', 'grant_type=client_credentials', 'grant_type=client_credentials&scope=ledger'])
  })
})

for (const [storeName, makeStore] of STORES) {
  describe(`signer factors, OAuth and hsh on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let owner: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      owner = await newKeyPair()
    })
    after(() => server.close())

    const raw = async (p: Promise<any>) => (await p).response.data
    const mine = () => [{ action: 'any', signer: { public: owner.public } }]

    async function withSigner(handle = 'admin') {
      const l = await newLedger(server.base, owner)
      const s: any = l.sdk
      await s.signer.init().data({ handle, public: owner.public, format: 'ed25519-raw', access: mine() }).hash().sign([{ keyPair: owner }]).send()
      return { ...l, s, factors: (signer = handle) => s.signer.with(signer).factor }
    }

    test('a key-pair factor: created, served with secret null outside its hash, updated, listed with total 0, dropped', async () => {
      const { factors } = await withSigner()
      const other = await newKeyPair()
      const data = { handle: 'k1', signer: 'admin', schema: 'key-pair', format: 'ed25519-raw', public: other.public, access: mine() }
      const made: any = await raw(factors().init().data(data).hash().sign([{ keyPair: owner }]).send())
      assert.match(made.luid, /^\$snf\./)
      assert.equal(made.data.secret, null)
      assert.equal(made.hash, hashData(data))
      assert.equal(made.meta.status, 'created')
      const dup = await failure(factors().init().data(data).hash().sign([{ keyPair: owner }]).send())
      assert.equal(dup.status, 409)
      const updated: any = await raw(factors().from(made).data({ custom: { title: 'x' } }).hash().sign([{ keyPair: owner }]).send())
      assert.equal(updated.data.custom.title, 'x')
      const changes: any = await raw(factors().with('k1').change.list())
      assert.equal(changes.page.total, 2)
      assert.ok(!('secret' in changes.data[0].data), 'changes hold the data as hashed')
      const list: any = await raw(factors().list())
      assert.deepEqual(list.page, { index: 0, limit: 20, total: 0 })
      assert.deepEqual(list.data.map((f: any) => f.data.handle), ['k1'])
      await factors().drop('k1').hash().sign([{ keyPair: owner }]).send()
      assert.equal((await failure(factors().read('k1'))).status, 404)
      assert.equal((await failure(factors().with(made.luid).change.list())).status, 404)
    })

    test('a factor read or created under another signer is record.invalid; an unknown signer is not found', async () => {
      const { s, factors } = await withSigner()
      await s.signer.init().data({ handle: 'bob', access: mine() }).hash().sign([{ keyPair: owner }]).send()
      const data = { handle: 'k', signer: 'admin', schema: 'key-pair', format: 'ed25519-raw', public: owner.public, access: mine() }
      await factors().init().data(data).hash().sign([{ keyPair: owner }]).send()
      const read = await failure(factors('bob').read('k'))
      assert.deepEqual([read.status, read.reason], [422, 'record.invalid'])
      const wrong = await failure(factors().init().data({ ...data, handle: 'k2', signer: 'bob' }).hash().sign([{ keyPair: owner }]).send())
      assert.deepEqual([wrong.status, wrong.reason], [422, 'record.invalid'])
      const ghost = await failure(factors('ghost').init().data({ ...data, handle: 'k3', signer: 'ghost' }).hash().sign([{ keyPair: owner }]).send())
      assert.deepEqual([ghost.status, ghost.reason, ghost.detail], [422, 'record.relation-not-found', 'Referenced Signer ghost not found.'])
      const noPublic = await failure(factors().init().data({ handle: 'k4', signer: 'admin', schema: 'key-pair', format: 'ed25519-raw' }).hash().sign([{ keyPair: owner }]).send())
      assert.deepEqual(
        noPublic.body.data.custom.errors.map((e: any) => e.errorCode),
        ['unevaluatedProperties.openapi.validation', 'enum.openapi.validation', 'required.openapi.validation', 'anyOf.openapi.validation'],
      )
    })

    test('secrets: sealed, never served unless asked with include=meta.secret', async () => {
      const { factors } = await withSigner()
      const data = { handle: 'sealed', signer: 'admin', schema: 'key-pair', format: 'ed25519-raw', public: owner.public, secret: '{{ secret.private }}', access: mine() }
      const missing = await failure(factors().init().data(data).hash().sign([{ keyPair: owner }]).send())
      assert.equal(missing.reason, 'record.invalid')
      await factors().init().data(data).meta({ proofs: [], secret: { private: 'PEM' } }).hash().sign([{ keyPair: owner }]).send()
      const plain: any = await raw(factors().read('sealed'))
      assert.equal(plain.meta.secret, undefined)
      assert.equal(plain.data.secret, '{{ secret.private }}')
      const shown: any = await raw(factors().read('sealed', { query: { include: ['meta.secret'] } }))
      assert.deepEqual(shown.meta.secret, { private: 'PEM' })
    })

    test('oauth client credentials: generated, re-hashed, no client proofs; own credentials refused', async () => {
      const { factors } = await withSigner()
      const sent = { handle: 'creds', signer: 'admin', schema: 'oauth-client-credentials', access: mine() }
      const made: any = await raw(factors().init().data(sent).meta({ proofs: [] }).hash().sign([{ keyPair: owner }]).send({ query: { include: ['meta.secret'] } }))
      assert.match(made.data.clientId, /^[A-Za-z0-9_-]{22}$/)
      assert.equal(made.data.clientSecret, '{{ secret.clientSecret }}')
      assert.match(made.meta.secret.clientSecret, /^[A-Za-z0-9_-]{43}$/)
      assert.equal(made.hash, hashData(made.data))
      assert.equal(made.meta.proofs.length, 1)
      assert.equal(made.meta.proofs[0].signer, 'system')
      assert.deepEqual(made.meta.owners, [])
      assert.equal(made.meta.status, undefined)
      const again: any = await raw(factors().read('creds', { query: { include: ['meta.secret'] } }))
      assert.equal(again.meta.secret.clientSecret, made.meta.secret.clientSecret)
      const own = await failure(factors().init().data({ ...sent, handle: 'c2', clientId: 'mine' }).meta({ proofs: [] }).hash().sign([{ keyPair: owner }]).send())
      assert.equal(own.reason, 'record.invalid')
    })

    async function oauthLedger(policy = true) {
      const l = await withSigner('prov')
      const rsa = await createRsaKeyPair('der')
      await l.factors().init()
        .data({ handle: 'prov-key', signer: 'prov', schema: 'key-pair', format: 'rsa-der', public: rsa.public, secret: '{{ secret.private }}', access: mine() })
        .meta({ proofs: [], secret: { private: rsa.secret } })
        .hash()
        .sign([{ keyPair: owner }])
        .send()
      const app = await newKeyPair()
      await l.s.signer.init().data({ handle: 'app', public: app.public, format: 'ed25519-raw', access: mine() }).hash().sign([{ keyPair: owner }]).send()
      const creds: any = await raw(l.factors('app').init().data({ handle: 'app-creds', signer: 'app', schema: 'oauth-client-credentials', access: mine() }).meta({ proofs: [] }).hash().sign([{ keyPair: owner }]).send({ query: { include: ['meta.secret'] } }))
      if (policy)
        await l.s.policy.init()
          .data({ handle: 'oauth', schema: 'authentication', record: 'any', access: mine(), values: [{ schema: 'oauth2', signer: { handle: 'prov' }, config: { 'jwt.ttl': 600 } }] })
          .hash()
          .sign([{ keyPair: owner }])
          .send()
      const token = (body: string, headers: Record<string, string> = {}) =>
        fetch(`${server.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ledger': l.handle, ...headers }, body })
      const basic = (id = creds.data.clientId, secret = creds.meta.secret.clientSecret) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` })
      return { ...l, creds, token, basic }
    }

    test('oauth token: an RS256 JWT from the provider key, claims as recorded', async () => {
      const { token, basic, handle } = await oauthLedger()
      const res = await token('grant_type=client_credentials', basic())
      assert.equal(res.status, 200)
      const body: any = await res.json()
      assert.deepEqual([body.token_type, body.expires_in], ['Bearer', 600])
      assert.deepEqual(decodeProtectedHeader(body.access_token), { alg: 'RS256', kid: 'prov-key' })
      const claims = decodeJwt(body.access_token)
      assert.deepEqual([claims.iss, claims.cid, claims.sub, claims.aud], ['prov', 'app-creds', 'app', server.base])
      assert.equal(claims.exp! - claims.iat!, 600)
      // The token works as a bearer, and impersonates `app` with origin oauth2-token.
      const asApp: any = new LedgerSdk({ server: server.base, ledger: handle, secure: { overrideToken: body.access_token } as any })
      const sym: any = await raw(asApp.symbol.init().data({ handle: 'usd', factor: 100, access: mine() }).meta({ proofs: [{ custom: { status: 'created' } }] }).hash().send())
      const proof = sym.meta.proofs[0]
      assert.deepEqual([proof.signer, proof.origin, proof.issuer, proof.custom['bearer.cid']], ['app', 'oauth2-token', 'prov', 'app-creds'])
    })

    test('oauth token errors follow RFC 6749, unsigned', async () => {
      const { token, basic, creds } = await oauthLedger()
      const expect = async (p: Promise<Response>, status: number, error: string) => {
        const r = await p
        const body: any = await r.json()
        assert.deepEqual([r.status, body.error], [status, error])
        assert.equal(body.hash, undefined)
      }
      await expect(token('', basic()), 400, 'invalid_request')
      await expect(token('grant_type=password', basic()), 400, 'unsupported_grant_type')
      await expect(token('grant_type=client_credentials'), 400, 'invalid_request')
      await expect(token('grant_type=client_credentials', basic(creds.data.clientId, 'wrong')), 401, 'invalid_client')
      await expect(token('grant_type=client_credentials', basic('nobody')), 401, 'invalid_client')
      const form = `grant_type=client_credentials&client_id=${creds.data.clientId}&client_secret=${creds.meta.secret.clientSecret}`
      assert.equal((await token(form)).status, 200)
      const off = await oauthLedger(false)
      await expect(off.token('grant_type=client_credentials', off.basic()), 400, 'invalid_grant')
      // Recorded (auth2): credentials are checked before the policy.
      await expect(off.token('grant_type=client_credentials', off.basic(off.creds.data.clientId, 'wrong')), 401, 'invalid_client')
    })

    test('a value whose target.schema is another signer schema is as good as no policy (auth2)', async () => {
      const l = await oauthLedger(false)
      await l.s.policy.init()
        .data({ handle: 'oauth', schema: 'authentication', record: 'any', access: mine(), values: [{ schema: 'oauth2', signer: { handle: 'prov' }, target: { schema: 'service' } }] })
        .hash()
        .sign([{ keyPair: owner }])
        .send()
      const r = await l.token('grant_type=client_credentials', l.basic())
      assert.deepEqual([r.status, ((await r.json()) as any).error], [400, 'invalid_grant'])
    })

    test('include=meta.secret needs a signer rule matching the token key; a bearer read rule is not enough (auth2)', async () => {
      const { factors, handle } = await withSigner()
      await factors().init()
        .data({ handle: 'sealed', signer: 'admin', schema: 'key-pair', format: 'ed25519-raw', public: (await newKeyPair()).public, secret: '{{ secret.private }}', access: mine() })
        .meta({ proofs: [], secret: { private: 'PEM' } })
        .hash()
        .sign([{ keyPair: owner }])
        .send()
      const k = await newKeyPair()
      const asK: any = new LedgerSdk({ server: server.base, ledger: handle, secure: { iss: k.public, sub: `signer:${k.public}`, aud: handle, exp: 3600, kid: k.public, keyPair: k } as any })
      // The test ledger is open (`{any, record: any}`): K may read, but no signer rule names K.
      assert.equal((await raw(asK.signer.with('admin').factor.read('sealed'))).data.handle, 'sealed')
      const refused = await failure(asK.signer.with('admin').factor.read('sealed', { query: { include: ['meta.secret'] } }))
      assert.deepEqual([refused.status, refused.reason, refused.detail], [403, 'auth.forbidden', 'Missing permissions'])
      assert.deepEqual((await raw(factors().read('sealed', { query: { include: ['meta.secret'] } }))).meta.secret, { private: 'PEM' })
    })

    test('a forged RS256 token, or one whose kid is no provider key, is refused', async () => {
      const { token, basic, s, handle } = await oauthLedger()
      const good: any = await (await token('grant_type=client_credentials', basic())).json()
      const [h, p, sig] = good.access_token.split('.')
      const forged = `${h}.${p}.${sig.split('').reverse().join('')}`
      const bad: any = new LedgerSdk({ server: server.base, ledger: handle, secure: { overrideToken: forged } as any })
      assert.equal((await failure(bad.wallet.list())).status, 401)
      // An RSA key that is not the provider's: same kid, other signature.
      const rsa = await createRsaKeyPair('pem')
      const other = await new SignJWT({ iss: 'prov', sub: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'prov-key' }).setIssuedAt().setExpirationTime('1h').sign(createPrivateKey(rsa.secret))
      const asOther: any = new LedgerSdk({ server: server.base, ledger: handle, secure: { overrideToken: other } as any })
      assert.equal((await failure(asOther.wallet.list())).status, 401)
      void s
    })

    test('hsh: checked against the public URL, protected headers, query and body', async () => {
      const { handle, s } = await withSigner()
      await s.wallet.init().data({ handle: 'w1', access: mine() }).hash().sign([{ keyPair: owner }]).send()
      const call = async (path: string, hsh: unknown, method = 'GET', body?: unknown) => {
        const jwt = await new SignJWT({ iss: owner.public, sub: owner.public, aud: handle, ...(hsh === undefined ? {} : { hsh }) })
          .setProtectedHeader({ alg: 'EdDSA', kid: owner.public })
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(edKey(owner))
        const r = await fetch(`${server.base}${path}`, { method, headers: { authorization: `Bearer ${jwt}`, 'x-ledger': handle, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
        return r.status
      }
      const of = (url: string, headers: Record<string, string> | null = { 'x-ledger': handle }, method = 'GET', body: unknown = null) =>
        hashData({ method, url, body, headers }) + (headers ? `:${Object.keys(headers).join(',')}` : '')
      const url = `${server.base}/wallets/w1`
      assert.equal(await call('/wallets/w1', undefined), 200)
      assert.equal(await call('/wallets/w1', ''), 200)
      assert.equal(await call('/wallets/w1', of(url)), 200)
      assert.equal(await call('/wallets/w1', of(url, null)), 200)
      assert.equal(await call('/wallets/w1', of(`${server.base}/wallets/w2`)), 401)
      assert.equal(await call('/wallets/w1', of(url, { 'x-ledger': 'other' })), 401)
      assert.equal(await call('/wallets/w1', 'abc'), 401)
      assert.equal(await call('/wallets?data.handle=w1', of(`${server.base}/wallets?data.handle=w1`)), 200)
      assert.equal(await call('/wallets?data.handle=w1', of(`${server.base}/wallets`)), 401)
      const record: any = await s.symbol.init().data({ handle: 'usd', factor: 100, access: mine() }).hash().sign([{ keyPair: owner }]).read()
      const other: any = await s.symbol.init().data({ handle: 'eur', factor: 100, access: mine() }).hash().sign([{ keyPair: owner }]).read()
      const bodyHsh = of(`${server.base}/symbols`, { 'x-ledger': handle }, 'POST', record)
      assert.equal(await call('/symbols', bodyHsh, 'POST', other), 401)
      assert.equal(await call('/symbols', bodyHsh, 'POST', record), 201)
      // The SDK's own hsh, with the URL it used.
      const withHsh: any = new LedgerSdk({ server: server.base, ledger: handle, secure: { iss: owner.public, sub: owner.public, aud: handle, exp: 300, createHsh: true, kid: owner.public, keyPair: owner } as any })
      assert.equal((await raw(withHsh.wallet.read('w1'))).data.handle, 'w1')
    })
  })
}
