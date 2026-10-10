// Signer factors (spec: /signers/{signer}/factors…, 9 operations). Open questions:
// is a factor a record with the generic lifecycle (update by parent hash, status by
// proof, changes, access check, drop)? What is its luid prefix, and what comes back
// for `secret` fields — a key pair's `{{ secret.x }}` with `meta.secret`, and the
// generated `clientId`/`clientSecret` of an `oauth-client-credentials` factor, with and
// without `include=meta.secret`? What does a factor under the wrong or a missing
// signer get, and may a factor be created by someone other than its signer?
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { sdk, keyPair, step, mine, LEDGER, BASE } = await scenario()
const s: any = sdk
const b = await createKeyPair()
const auth = (k: any) => ({ iss: k.public, sub: `signer:${k.public}`, aud: LEDGER, exp: 3600, createHsh: false, kid: k.public, keyPair: k }) as any
const asB: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(b) })
const factors = (signer: string, who: any = s) => who.signer.with(signer).factor

await step('signer.create admin', () => s.signer.init().data({ handle: 'admin', public: keyPair.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
await step('signer.create bob', () => asB.signer.init().data({ handle: 'bob', public: b.public, format: 'ed25519-raw' }).hash().sign([{ keyPair: b }]).send())

const extra = await createKeyPair()
const keyFactor = (handle: string, signer = 'admin') => ({ handle, signer, schema: 'key-pair', format: 'ed25519-raw', public: extra.public, custom: { title: 'backup key' }, access: mine })

// The record surface.
const made = await step('factor.create signing-key', () => factors('admin').init().data(keyFactor('signing-key')).hash().sign([{ keyPair }]).send())
await step('factor.create signing-key again', () => factors('admin').init().data(keyFactor('signing-key')).hash().sign([{ keyPair }]).send())
await step('factor.read signing-key', () => factors('admin').read('signing-key'))
if (made?.response?.data?.luid) await step('factor.read by luid', () => factors('admin').read(made.response.data.luid))
await step('factor.read under bob', () => factors('bob').read('signing-key'))
await step('factor.read missing', () => factors('admin').read('nope'))
await step('factor.list admin', () => factors('admin').list())
await step('factor.list bob', () => factors('bob').list())
const current = await step('factor.read for update', () => factors('admin').read('signing-key'))
if (current) await step('factor.update', () => factors('admin').from(current.response.data).data({ custom: { title: 'primary key' } }).hash().sign([{ keyPair }]).send())
await step('factor.update stale parent', () => current && factors('admin').from(current.response.data).data({ custom: { title: 'stale' } }).hash().sign([{ keyPair }]).send())
const again = await step('factor.read after update', () => factors('admin').read('signing-key'))
if (again) await step('factor.proof status active', () => factors('admin').from(again.response.data).hash().sign([{ keyPair, custom: { status: 'active' } }]).send())
await step('factor.access check update', () => factors('admin').with('signing-key').access.check({ data: { action: 'update' } }).hash().sign([{ keyPair }]).send())
await step('factor.changes', () => factors('admin').with('signing-key').change.list())
await step('factor.change 1', () => factors('admin').with('signing-key').change.read(1))
await step('factor.change 9', () => factors('admin').with('signing-key').change.read(9))

// Where a factor may be created.
await step('factor.create under missing signer', () => factors('ghost').init().data(keyFactor('k', 'ghost')).hash().sign([{ keyPair }]).send())
await step('factor.create data.signer differs from path', () => factors('admin').init().data(keyFactor('k2', 'bob')).hash().sign([{ keyPair }]).send())
await step('factor.create without schema', () => factors('admin').init().data({ handle: 'k3', signer: 'admin', access: mine }).hash().sign([{ keyPair }]).send())
await step('factor.create unknown schema', () => factors('admin').init().data({ handle: 'k4', signer: 'admin', schema: 'totp', access: mine }).hash().sign([{ keyPair }]).send())
await step('factor.create key-pair without public', () => factors('admin').init().data({ handle: 'k5', signer: 'admin', schema: 'key-pair', format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())
await step('factor.create on bob by bob', () => factors('bob', asB).init().data({ ...keyFactor('bob-key', 'bob'), access: [] }).hash().sign([{ keyPair: b }]).send())

// Secrets: a key pair holding a private key, and generated OAuth credentials.
const secretFactor = { ...keyFactor('sealed', 'admin'), secret: '{{ secret.private }}' }
await step('factor.create secret without meta.secret', () => factors('admin').init().data(secretFactor).hash().sign([{ keyPair }]).send())
await step('factor.create secret', () => factors('admin').init().data(secretFactor).meta({ proofs: [], secret: { private: 'PRIVATE-KEY-PEM' } }).hash().sign([{ keyPair }]).send())
await step('factor.read sealed', () => factors('admin').read('sealed'))
await step('factor.read sealed include secret', () => factors('admin').read('sealed', { query: { include: ['meta.secret'] } }))

const oauth = { handle: 'app-creds', signer: 'bob', schema: 'oauth-client-credentials', access: mine }
await step('factor.create oauth', () => factors('bob').init().data(oauth).meta({ proofs: [] }).hash().sign([{ keyPair }]).send())
await step('factor.create oauth include secret', () =>
  factors('bob').init().data({ ...oauth, handle: 'app-creds-2' }).meta({ proofs: [] }).hash().sign([{ keyPair }]).send({ query: { include: ['meta.secret'] } }),
)
await step('factor.read oauth', () => factors('bob').read('app-creds'))
await step('factor.read oauth include secret', () => factors('bob').read('app-creds', { query: { include: ['meta.secret'] } }))
await step('factor.create oauth with clientId', () => factors('bob').init().data({ ...oauth, handle: 'app-creds-3', clientId: 'my-client' }).meta({ proofs: [] }).hash().sign([{ keyPair }]).send())
await step('factor.list bob after', () => factors('bob').list())

// Drop: 204, then gone; history by luid.
const before = await step('factor.read before drop', () => factors('admin').read('signing-key'))
await step('factor.drop', () => factors('admin').drop('signing-key').hash().sign([{ keyPair }]).send())
await step('factor.read after drop', () => factors('admin').read('signing-key'))
if (before?.response?.data?.luid) await step('factor.changes by luid after drop', () => factors('admin').with(before.response.data.luid).change.list())
await step('factor.drop missing', () => factors('admin').drop('signing-key').hash().sign([{ keyPair }]).send())
await step('factor.list admin after drop', () => factors('admin').list())
