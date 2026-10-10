// OAuth 2.0 client credentials (spec: createAccessToken; authenticate-with-oauth.md).
// Open questions: the token response and errors (RFC 6749 shape or the ledger's
// envelope?), signed or not, what the minted JWT carries (kid, iss, sub, aud, exp vs
// `jwt.ttl`), what happens without an authentication policy, and what a mutation made
// with only the minted token looks like (an impersonated proof for the app signer?).
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair, createRsaKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { sdk, keyPair, step, mine, LEDGER, BASE } = await scenario()
const s: any = sdk
const prov = await createKeyPair()
const app = await createKeyPair()
const rsa = await createRsaKeyPair('der')
const decode = (jwt: string) => jwt.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8')))
// Shapes only: values differ per run.
const shape = (o: any) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, typeof v === 'string' && v.length > 24 ? `<${v.length} chars>` : v]))

await step('signer.create prov', () => s.signer.init().data({ handle: 'prov', public: prov.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
await step('factor.create prov-key (rsa)', () =>
  s.signer.with('prov').factor.init()
    .data({ handle: 'prov-key', signer: 'prov', schema: 'key-pair', format: 'rsa-der', public: rsa.public, secret: '{{ secret.private }}', access: mine })
    .meta({ proofs: [], secret: { private: rsa.secret } })
    .hash()
    .sign([{ keyPair }])
    .send(),
)
await step('signer.create app', () => s.signer.init().data({ handle: 'app', public: app.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
const creds = await step('factor.create app-creds', () =>
  s.signer.with('app').factor.init()
    .data({ handle: 'app-creds', signer: 'app', schema: 'oauth-client-credentials', access: mine })
    .meta({ proofs: [] })
    .hash()
    .sign([{ keyPair }])
    .send({ query: { include: ['meta.secret'] } }),
)
const clientId: string = creds?.response?.data?.data?.clientId ?? 'none'
const clientSecret: string = creds?.response?.data?.meta?.secret?.clientSecret ?? 'none'
console.log(`      clientId ${clientId.length} chars, clientSecret ${clientSecret.length} chars`)

const raw = (body: string, headers: Record<string, string> = {}) =>
  step(`POST /oauth/token ${body || '(empty)'}${headers.authorization ? ' +basic' : ''}`, async () => {
    const res = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ledger': LEDGER, ...headers }, body })
    const text = await res.text()
    console.log(`      ${res.status} ${text.length > 300 ? text.slice(0, 300) + '…' : text}`)
    return res.ok ? JSON.parse(text) : undefined
  })
const basic = (id: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` })

await step('oauth.exchange before any policy', () => s.oauth.exchangeToken(clientId, clientSecret))

await step('policy.create authentication', () =>
  s.policy.init()
    .data({ handle: 'oauth', schema: 'authentication', record: 'any', access: mine, values: [{ schema: 'oauth2', signer: { handle: 'prov' }, config: { 'jwt.ttl': 600 } }] })
    .hash()
    .sign([{ keyPair }])
    .send(),
)

const got = await step('oauth.exchange', () => s.oauth.exchangeToken(clientId, clientSecret))
const token: string | undefined = got?.accessToken
if (token) {
  const [header, payload] = decode(token)
  console.log(`      header ${JSON.stringify(header)}`)
  console.log(`      payload ${JSON.stringify(shape(payload))} ttl ${payload.exp - payload.iat}`)
}
await step('oauth.exchange wrong secret', () => s.oauth.exchangeToken(clientId, 'wrong'))
await step('oauth.exchange unknown client', () => s.oauth.exchangeToken('nobody', clientSecret))
await raw('grant_type=client_credentials', basic(clientId, clientSecret))
await raw(`grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`)
await raw('', basic(clientId, clientSecret))
await raw('grant_type=password', basic(clientId, clientSecret))
await raw('grant_type=client_credentials')

// The minted token as a bearer: a read, and a mutation with no signature of its own.
if (token) {
  const bearer: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: { overrideToken: token } as any })
  await step('wallet.create by owner', () => s.wallet.init().data({ handle: 'w1', access: mine }).hash().sign([{ keyPair }]).send())
  await step('wallet.read with oauth token', () => bearer.wallet.read('w1'))
  await step('symbol.create with oauth token only, no hash', () =>
    bearer.symbol.init().data({ handle: 'usd', factor: 100, access: mine }).meta({ proofs: [{ custom: { status: 'created' } }] }).send(),
  )
  // Impersonation: does the ledger sign for the token's subject (`app`)?
  await step('symbol.create with oauth token only', () =>
    bearer.symbol.init().data({ handle: 'usd', factor: 100, access: mine }).meta({ proofs: [{ custom: { status: 'created' } }] }).hash().send(),
  )
  await step('symbol.read usd', () => s.symbol.read('usd'))
  // A token for another ledger's audience, and one whose signature is not the provider's.
  const [header, payload] = decode(token)
  const forged = [header, payload].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.') + '.' + token.split('.')[2].split('').reverse().join('')
  const bad: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: { overrideToken: forged } as any })
  await step('wallet.read with forged oauth token', () => bad.wallet.read('w1'))
}
