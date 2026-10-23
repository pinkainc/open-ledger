// OAuth client credentials the client brings itself (`signer.factor.oauth.allowClientCredentials`,
// release notes v2.38.0, spec `oauth-client-credentials-signer-factor-data`). One ledger with the
// flag on: is the given clientId kept, must the secret be `{{ secret.clientSecret }}` with its value
// in `meta.secret`, what does a literal secret or a missing value do, may two factors share a
// clientId, and does the token exchange work with the brought credentials. Then the flag off again.
import { createKeyPair, createRsaKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { sdk, keyPair, step, mine } = await scenario({ config: { 'signer.factor.oauth.allowClientCredentials': true } })
const s: any = sdk
const prov = await createKeyPair()
const app = await createKeyPair()
const rsa = await createRsaKeyPair('der')

await step('signer.create prov', () => s.signer.init().data({ handle: 'prov', public: prov.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
await step('factor.create prov-key', () =>
  s.signer.with('prov').factor.init()
    .data({ handle: 'prov-key', signer: 'prov', schema: 'key-pair', format: 'rsa-der', public: rsa.public, secret: '{{ secret.private }}', access: mine })
    .meta({ proofs: [], secret: { private: rsa.secret } })
    .hash()
    .sign([{ keyPair }])
    .send(),
)
await step('signer.create app', () => s.signer.init().data({ handle: 'app', public: app.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())

const factor = (name: string, data: Record<string, unknown>, meta: Record<string, unknown> = {}) =>
  step(`factor.create ${name}`, () =>
    s.signer.with('app').factor.init()
      .data({ handle: name, signer: 'app', schema: 'oauth-client-credentials', access: mine, ...data })
      .meta({ proofs: [], ...meta })
      .hash()
      .sign([{ keyPair }])
      .send({ query: { include: ['meta.secret'] } }),
  )

const SECRET = 'brought-secret-0123456789abcdef'
const both = await factor('own-both', { clientId: 'client-own-both', clientSecret: '{{ secret.clientSecret }}' }, { secret: { clientSecret: SECRET } })
console.log(`      clientId ${both?.response?.data?.data?.clientId} secret kept ${both?.response?.data?.meta?.secret?.clientSecret === SECRET}`)
const idOnly = await factor('own-id', { clientId: 'client-own-id' })
console.log(`      generated secret ${idOnly?.response?.data?.meta?.secret?.clientSecret?.length ?? 0} chars`)
const secretOnly = await factor('own-secret', { clientSecret: '{{ secret.clientSecret }}' }, { secret: { clientSecret: SECRET } })
console.log(`      generated clientId ${secretOnly?.response?.data?.data?.clientId?.length ?? 0} chars, secret kept ${secretOnly?.response?.data?.meta?.secret?.clientSecret === SECRET}`)
await factor('literal-secret', { clientId: 'client-literal', clientSecret: SECRET })
await factor('missing-value', { clientId: 'client-missing', clientSecret: '{{ secret.clientSecret }}' })
await factor('dup-client', { clientId: 'client-own-both' })
await factor('empty-client', { clientId: '' })

await step('policy.create authentication', () =>
  s.policy.init()
    .data({ handle: 'oauth', schema: 'authentication', record: 'any', access: mine, values: [{ schema: 'oauth2', signer: { handle: 'prov' }, config: { 'jwt.ttl': 600 } }] })
    .hash()
    .sign([{ keyPair }])
    .send(),
)
const got = await step('oauth.exchange own-both', () => s.oauth.exchangeToken('client-own-both', SECRET))
console.log(`      token ${typeof got?.accessToken === 'string' ? 'issued' : 'none'}`)
await step('oauth.exchange own-both wrong secret', () => s.oauth.exchangeToken('client-own-both', 'wrong'))
await step('oauth.exchange own-secret by clientId', () => s.oauth.exchangeToken(secretOnly?.response?.data?.data?.clientId ?? 'none', SECRET))

// The flag off again: a brought clientId is refused, the factors made before stay usable.
await step('ledger.update flag off', async () => {
  const cur: any = (await s.ledger.read()).response.data
  return s.ledger.from(cur)
    .data({ config: { ...cur.data.config, 'signer.factor.oauth.allowClientCredentials': false } })
    .hash()
    .sign([{ keyPair }])
    .send()
})
await factor('after-off', { clientId: 'client-after-off' })
await step('oauth.exchange own-both after off', () => s.oauth.exchangeToken('client-own-both', SECRET))
