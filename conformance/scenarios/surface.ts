// The generic record surface on the kinds where no recording reached it yet (S9 point
// 6): a proof, an access check, the change list, one change by number, and drop by
// POST …/drop. The same operations are recorded on other kinds; this confirms the
// shared handlers answer alike everywhere. Nothing here calls out: the bridge and the
// webhook point at a closed local port, and the effect listens for a signal nothing
// in this ledger raises.
import { createKeyPair, signJWT } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { sdk, keyPair, step, mine, LEDGER, BASE } = await scenario()
const s: any = sdk
const signed = (b: any) => b.hash().sign([{ keyPair }]).send()
const make = (client: string, data: Record<string, unknown>) => step(`${client}.create ${data.handle}`, () => signed(s[client].init().data({ access: mine, ...data })))

// A raw signed request, for what the SDK has no call for (POST …/drop, a circle link).
async function raw(name: string, method: string, path: string, body?: unknown) {
  const iat = Math.floor(Date.now() / 1000)
  const jwt = await signJWT({ iat, exp: iat + 300, iss: keyPair.public, aud: LEDGER, sub: `signer:${keyPair.public}` }, keyPair.secret, keyPair.public)
  return step(name, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, 'x-ledger': LEDGER, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    console.log(`      ${res.status} ${(await res.text()).slice(0, 120).replace(/\n/g, '\\n')}`)
  })
}

/** Proof, access check, changes and change 1 of one record. */
async function surface(client: string, handle: string, path: string) {
  const r = await step(`${client}.read ${handle}`, () => s[client].read(handle))
  if (r) await step(`${client}.proof ${handle}`, () => s[client].from(r.response.data).hash().sign([{ keyPair, custom: { note: 'surface' } }]).send())
  await step(`${client}.access check ${handle}`, () => signed(s[client].with(handle).access.check({ data: { action: 'read' } })))
  await step(`${client}.changes ${handle}`, () => s[client].with(handle).change.list())
  await step(`${client}.change 1 ${handle}`, () => s[client].with(handle).change.read(1))
  await raw(`${client}.change 1 ${handle} raw`, 'GET', `${path}/${encodeURIComponent(handle)}/changes/1`)
}

/** Drop by POST …/drop, with the body the SDK builds for DELETE. */
async function dropByPost(client: string, handle: string, path: string, of: any = s[client]) {
  const body = await of.drop(handle).hash().sign([{ keyPair }]).read().catch(() => undefined)
  if (body) await raw(`${client}.drop ${handle} by POST`, 'POST', `${path}/${encodeURIComponent(handle)}/drop`, body)
  await raw(`${client}.read ${handle} after drop`, 'GET', `${path}/${encodeURIComponent(handle)}`)
}

const other = await createKeyPair()
const closed = 'http://127.0.0.1:9/v2'
await make('bridge', { handle: 'br', schema: 'rest', config: { server: closed }, secure: [] })
await make('effect', { handle: 'ef', signal: 'report-created', action: { schema: 'webhook', endpoint: closed } })
await make('domain', { handle: 'dm' })
await make('wallet', { handle: 'wl' })
await make('anchor', { handle: 'an', wallet: 'wl', target: 'wl' })
// On `symbol`: once a schema names a kind, every new record of it must name one.
await make('schema', { handle: 'sc', record: 'symbol', format: 'json-schema', schema: { type: 'object' } })
await make('policy', { handle: 'po', schema: 'status', record: 'wallet', values: [] })
await make('circle', { handle: 'ci' })
await step('signer.create ops', () => signed(s.signer.init().data({ handle: 'ops', public: other.public, format: 'ed25519-raw', access: mine })))
await step('circle.signer add ops', () => signed(s.circle.with('ci').signer.init().data({ circle: 'ci', signer: 'ops' })))
await step('factor.create k', () =>
  signed(s.signer.with('ops').factor.init().data({ handle: 'k', signer: 'ops', schema: 'key-pair', format: 'ed25519-raw', public: other.public, access: mine })),
)

await surface('bridge', 'br', '/bridges')
await surface('effect', 'ef', '/effects')
await surface('domain', 'dm', '/domains')
await surface('schema', 'sc', '/schemas')
await surface('anchor', 'an', '/anchors')
await surface('policy', 'po', '/policies')
await surface('circle', 'ci', '/circles')
await surface('signer', 'ops', '/signers')

await raw('circle.signer read ops', 'GET', '/circles/ci/signers/ops')
await dropByPost('circle.signer', 'ops', '/circles/ci/signers', s.circle.with('ci').signer)
await step('circle.signer add ops again', () => signed(s.circle.with('ci').signer.init().data({ circle: 'ci', signer: 'ops' })))
// Without a body (no proofs), then as the SDK sends it.
await raw('circle.signer delete ops without body', 'DELETE', '/circles/ci/signers/ops')
await step('circle.signer drop ops', () => signed(s.circle.with('ci').signer.drop('ops')))
await raw('circle.signers after delete', 'GET', '/circles/ci/signers')

await dropByPost('factor', 'k', '/signers/ops/factors', s.signer.with('ops').factor)
await dropByPost('bridge', 'br', '/bridges')
await dropByPost('effect', 'ef', '/effects')
await dropByPost('anchor', 'an', '/anchors')
// After the anchor: a wallet an anchor names may not be dropped.
await raw('wallet.delete without body', 'DELETE', '/wallets/wl')
await raw('wallet.drop by POST without body', 'POST', '/wallets/wl/drop')
await dropByPost('wallet', 'wl', '/wallets')
await dropByPost('policy', 'po', '/policies')
