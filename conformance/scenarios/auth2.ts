// What `factors` and `oauth` left open (TODO, Authentication `(?)`):
// - `/oauth/token` with wrong credentials while no authentication policy exists:
//   `invalid_grant` (policy first) or `invalid_client`?
// - does a read with `include=meta.secret` give the client secret of the creation?
// - who may ask for `include=meta.secret`: K may read every record (a bearer rule) but
//   has no rule on `signer-factor-secret`; then K gets one;
// - an authentication value's `target.schema`: tokens only for signers of that schema;
// - an external IdP: a token we mint ourselves with the provider's private key, whose
//   `sub` is a signer, or no signer at all.
// The ledger is not open: the operator may do anything, K may enter and read.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair, createRsaKeyPair } from '@minka/ledger-sdk/crypto'
import { SignJWT } from 'jose'
import { createPrivateKey } from 'node:crypto'
import { scenario } from './common.js'

const K = await createKeyPair()
const { sdk, keyPair, step, mine, LEDGER, BASE } = await scenario({
  access: (op) => [
    { action: 'any', record: 'any', signer: { public: op } },
    { action: 'read', record: 'any', bearer: { $signer: { public: op } } },
    { action: 'access' },
    { action: 'read', record: 'any', bearer: { $signer: { public: K.public } } },
  ],
})
const s: any = sdk
const asK: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: { iss: K.public, sub: `signer:${K.public}`, aud: LEDGER, exp: 3600, createHsh: false, kid: K.public, keyPair: K } as any })
const prov = await createKeyPair()
const app = await createKeyPair()
const svc = await createKeyPair()
const rsa = await createRsaKeyPair('der')
const ext = await createRsaKeyPair('der')
const token = (body: string) =>
  step(`POST /oauth/token ${body.replace(/client_secret=[^&]*/, 'client_secret=…')}`, async () => {
    const res = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ledger': LEDGER }, body })
    const text = await res.text()
    console.log(`      ${res.status} ${text.slice(0, 200)}`)
    return res.ok ? JSON.parse(text) : undefined
  })
const form = (id: string, secret: string) => `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`
const factorOf = (signer: string) => s.signer.with(signer).factor

await step('signer.create prov', () => s.signer.init().data({ handle: 'prov', public: prov.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
await step('factor.create prov-key', () =>
  factorOf('prov').init()
    .data({ handle: 'prov-key', signer: 'prov', schema: 'key-pair', format: 'rsa-der', public: rsa.public, secret: '{{ secret.private }}', access: mine })
    .meta({ proofs: [], secret: { private: rsa.secret } })
    .hash().sign([{ keyPair }]).send(),
)
await step('signer.create app', () => s.signer.init().data({ handle: 'app', public: app.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
const created = await step('factor.create app-creds include secret', () =>
  factorOf('app').init().data({ handle: 'app-creds', signer: 'app', schema: 'oauth-client-credentials', access: mine }).meta({ proofs: [] }).hash().sign([{ keyPair }]).send({ query: { include: ['meta.secret'] } }),
)
const clientId: string = created?.response?.data?.data?.clientId ?? 'none'
const secret0: string = created?.response?.data?.meta?.secret?.clientSecret ?? 'none'

// No authentication policy yet: wrong secret, unknown client, right secret.
await token(form(clientId, 'wrong'))
await token(form('nobody', 'wrong'))
await token(form(clientId, secret0))

// Reading the secret back: the operator, then K without and with a rule for it.
const read1 = await step('factor.read app-creds include secret', () => factorOf('app').read('app-creds', { query: { include: ['meta.secret'] } }))
const read2 = await step('factor.read app-creds include secret again', () => factorOf('app').read('app-creds', { query: { include: ['meta.secret'] } }))
const secret1 = read1?.response?.data?.meta?.secret?.clientSecret
console.log(`      read secret = created secret: ${secret1 === secret0}, read twice the same: ${secret1 === read2?.response?.data?.meta?.secret?.clientSecret}`)
await step('K factor.read app-creds', () => asK.signer.with('app').factor.read('app-creds'))
await step('K factor.read app-creds include secret', () => asK.signer.with('app').factor.read('app-creds', { query: { include: ['meta.secret'] } }))
await step('K factor.read prov-key include secret', () => asK.signer.with('prov').factor.read('prov-key', { query: { include: ['meta.secret'] } }))
await step('ledger.update K may read signer-factor-secret', async () => {
  const cur: any = (await s.ledger.read()).response.data
  return s.ledger.from(cur).data({ access: [...cur.data.access, { action: 'read', record: 'signer-factor-secret', bearer: { $signer: { public: K.public } } }] }).hash().sign([{ keyPair }]).send()
})
await step('K factor.read app-creds include secret (rule)', () => asK.signer.with('app').factor.read('app-creds', { query: { include: ['meta.secret'] } }))

// An external IdP: provider `idp` with a public key only; we sign its tokens.
await step('signer.create idp', async () => s.signer.init().data({ handle: 'idp', public: (await createKeyPair()).public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
await step('factor.create idp-key (public only)', () =>
  factorOf('idp').init().data({ handle: 'idp-key', signer: 'idp', schema: 'key-pair', format: 'rsa-der', public: ext.public, access: mine }).hash().sign([{ keyPair }]).send(),
)
// target.schema: tokens only for signers of schema `service`.
await step('schema.create service', () =>
  s.schema.init().data({ handle: 'service', record: 'signer', format: 'json-schema', schema: { type: 'object' }, access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create svc', () => s.signer.init().data({ handle: 'svc', schema: 'service', public: svc.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
const svcCreds = await step('factor.create svc-creds', () =>
  factorOf('svc').init().data({ handle: 'svc-creds', signer: 'svc', schema: 'oauth-client-credentials', access: mine }).meta({ proofs: [] }).hash().sign([{ keyPair }]).send({ query: { include: ['meta.secret'] } }),
)
await step('policy.create oauth (target.schema service)', () =>
  s.policy.init()
    .data({ handle: 'oauth', schema: 'authentication', record: 'any', access: mine, values: [{ schema: 'oauth2', signer: { handle: 'prov' }, target: { schema: 'service' } }] })
    .hash().sign([{ keyPair }]).send(),
)
await token(form(clientId, secret0))
await token(form(svcCreds?.response?.data?.data?.clientId ?? 'none', svcCreds?.response?.data?.meta?.secret?.clientSecret ?? 'none'))

await step('policy.create idp', () =>
  s.policy.init().data({ handle: 'idp', schema: 'authentication', record: 'any', access: mine, values: [{ schema: 'oauth2', signer: { handle: 'idp' } }] }).hash().sign([{ keyPair }]).send(),
)
await step('wallet.create w1', () => s.wallet.init().data({ handle: 'w1', access: [...mine, { action: 'read', bearer: { sub: 'app' } }] }).hash().sign([{ keyPair }]).send())
const mint = (sub: string) => {
  const iat = Math.floor(Date.now() / 1000)
  const key = createPrivateKey(ext.secret)
  return new SignJWT({ iss: 'idp', sub, aud: process.env.HSH_URL ?? BASE, iat, exp: iat + 600 }).setProtectedHeader({ alg: 'RS256', kid: 'idp-key' }).sign(key)
}
for (const sub of ['app', 'nobody']) {
  const bearer: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: { overrideToken: await mint(sub) } as any })
  await step(`wallet.read w1 with idp token sub ${sub}`, () => bearer.wallet.read('w1'))
  await step(`symbol.create with idp token sub ${sub}`, () =>
    bearer.symbol.init().data({ handle: `usd-${sub}`, factor: 100, access: mine }).meta({ proofs: [{ custom: { status: 'created' } }] }).hash().send(),
  )
}
