// The `hsh` token claim (about-authentication, "request hash"): sha256 of
// `{method, url, headers, body}`, suffixed with the protected header names. Open
// questions: does the reference check it at all, against which URL (the one the
// client used — here the recording proxy — or its own public address, HSH_URL), and
// how does it refuse a wrong one? Every case reads or creates with a token alone.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createHash, signJWT } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { sdk, keyPair, step, mine, LEDGER, BASE } = await scenario()
const s: any = sdk
// The address the server knows itself by. run.sh sets it to the reference's address
// in both modes, and our server's PUBLIC_URL to the same in a check.
const PUBLIC = process.env.HSH_URL ?? BASE

await step('wallet.create w1', () => s.wallet.init().data({ handle: 'w1', access: mine }).hash().sign([{ keyPair }]).send())

type Req = { method: string; url: string; body?: unknown; headers?: Record<string, string> | null }
const hshOf = (r: Req, suffix = r.headers ? Object.keys(r.headers).join(',') : '') =>
  createHash({ method: r.method, url: r.url, body: r.body ?? null, headers: r.headers ?? null }) + (suffix ? `:${suffix}` : '')

async function call(name: string, method: string, path: string, hsh: string | undefined, body?: unknown) {
  const iat = Math.floor(Date.now() / 1000)
  const jwt = await signJWT({ iat, exp: iat + 300, iss: keyPair.public, aud: LEDGER, sub: `signer:${keyPair.public}`, ...(hsh === undefined ? {} : { hsh }) }, keyPair.secret, keyPair.public)
  return step(name, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, 'x-ledger': LEDGER, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const out: any = await res.json().catch(() => undefined)
    console.log(`      ${res.status} ${out?.data?.reason ?? ''} ${out?.data?.detail ?? ''}`)
  })
}

const read = (url: string, headers: Record<string, string> | null = { 'x-ledger': LEDGER }) => ({ method: 'GET', url, headers })
await call('read without hsh', 'GET', '/wallets/w1', undefined)
await call('read hsh over the public url', 'GET', '/wallets/w1', hshOf(read(`${PUBLIC}/wallets/w1`)))
await call('read hsh over the proxy url', 'GET', '/wallets/w1', hshOf(read(`${BASE}/wallets/w1`)))
await call('read hsh public url, no protected headers', 'GET', '/wallets/w1', hshOf(read(`${PUBLIC}/wallets/w1`, null)))
await call('read hsh of another path', 'GET', '/wallets/w1', hshOf(read(`${PUBLIC}/wallets/w2`)))
await call('read hsh of another ledger header', 'GET', '/wallets/w1', hshOf(read(`${PUBLIC}/wallets/w1`, { 'x-ledger': 'other' })))
await call('read hsh garbage', 'GET', '/wallets/w1', 'abc')
await call('read hsh empty', 'GET', '/wallets/w1', '')
await call('read hsh naming a header not sent', 'GET', '/wallets/w1', hshOf({ ...read(`${PUBLIC}/wallets/w1`), headers: { 'x-ledger': LEDGER, 'x-api-key': 'k' } }))
await call('read hsh with method POST', 'GET', '/wallets/w1', hshOf({ ...read(`${PUBLIC}/wallets/w1`), method: 'POST' }))
await call('read hsh with query', 'GET', '/wallets?data.handle=w1', hshOf(read(`${PUBLIC}/wallets?data.handle=w1`)))
await call('read hsh with query, url without it', 'GET', '/wallets?data.handle=w1', hshOf(read(`${PUBLIC}/wallets`)))

// A signed create whose token binds the body.
const bodyOf = (handle: string): Promise<any> => sdk.symbol.init().data({ handle, factor: 100, access: mine } as any).hash().sign([{ keyPair }]).read()
const b1 = await bodyOf('usd').catch(() => undefined)
if (b1) {
  await call('create hsh over its body', 'POST', '/symbols', hshOf({ method: 'POST', url: `${PUBLIC}/symbols`, body: b1, headers: { 'x-ledger': LEDGER } }), b1)
  const b2 = await bodyOf('eur')
  await call('create hsh over another body', 'POST', '/symbols', hshOf({ method: 'POST', url: `${PUBLIC}/symbols`, body: b1, headers: { 'x-ledger': LEDGER } }), b2)
}
// The SDK's own: createHsh with the URL the client used.
const withHsh: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: { iss: keyPair.public, sub: `signer:${keyPair.public}`, aud: LEDGER, exp: 300, createHsh: true, kid: keyPair.public, keyPair } as any })
await step('sdk read with createHsh', () => withHsh.wallet.read('w1'))
await step('sdk create with createHsh', () => withHsh.symbol.init().data({ handle: 'gbp', factor: 100, access: mine }).hash().sign([{ keyPair }]).send())
