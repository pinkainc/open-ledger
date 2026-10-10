// The ledger collection and the journal (spec: listLedgers, dropLedger, dropLedgerPost,
// listRequests, readRequest). Open questions: who may list ledgers, and does a list
// show ledgers the caller cannot read? What may drop a ledger, what is left of it
// (a read, a list, its handle)? What does the journal record of a ledger's requests,
// and who may read it?
//
// The sandbox holds every ledger ever made, so each list is filtered on this run's
// `custom.run` (own-ledger.ts keeps an exchange whose url names the run).
import { LedgerSdk } from '@minka/ledger-sdk'
import { createHash, createKeyPair, signHash, signJWT } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { sdk, keyPair, step, LEDGER, BASE, secure } = await scenario({ skipLedger: true })
const RUN = LEDGER.slice('open-ledger-conf-'.length)
const stranger = await createKeyPair()

const A = LEDGER
const B = `${LEDGER}-b`
const C = `${LEDGER}-c`
const root = new LedgerSdk({ server: BASE, secure })
const makeLedger = (handle: string, access: unknown[]) =>
  step(`ledger.create ${handle.slice(LEDGER.length) || 'a'}`, () =>
    root.ledger.init().data({ handle, signer: 'system', custom: { run: RUN }, access } as any).hash().sign([{ keyPair }]).send(),
  )
await makeLedger(A, [{ action: 'any', record: 'any' }])
await makeLedger(B, [{ action: 'any', signer: { public: keyPair.public } }])
await makeLedger(C, [{ action: 'any', signer: { public: keyPair.public } }])

// ---- the list ------------------------------------------------------------------------

async function raw(name: string, method: string, path: string, opts: { ledger?: string; key?: typeof keyPair | null; body?: unknown } = {}) {
  const key = opts.key === undefined ? keyPair : opts.key
  const headers: Record<string, string> = { 'x-conf-run': RUN }
  if (key) {
    const iat = Math.floor(Date.now() / 1000)
    headers.authorization = `Bearer ${await signJWT({ iat, exp: iat + 300, iss: key.public, aud: opts.ledger ?? A, sub: `signer:${key.public}` }, key.secret, key.public)}`
  }
  if (opts.ledger) headers['x-ledger'] = opts.ledger
  if (opts.body) headers['content-type'] = 'application/json'
  return step(name, async () => {
    const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
    const out: any = await res.json().catch(() => undefined)
    console.log(`      ${res.status} ${out?.data?.reason ?? ''} ${out?.data?.detail ?? ''}`)
    return out
  })
}

const mine = `data.custom.run=${RUN}`
await raw('ledgers list without a token', 'GET', `/ledgers?${mine}`, { key: null })
await raw('ledgers list, stranger token', 'GET', `/ledgers?${mine}`, { key: stranger })
await step('ledgers list (sdk)', () => root.ledger.list({ 'data.custom.run': RUN } as any))
await raw('ledgers list, page of 2', 'GET', `/ledgers?${mine}&page.limit=2`)
await raw('ledgers list, with x-ledger', 'GET', `/ledgers?${mine}`, { ledger: A })

// ---- the journal ---------------------------------------------------------------------

await step('wallet.create w1', () =>
  sdk.wallet.init().data({ handle: 'w1', access: [{ action: 'any', record: 'any' }] } as any).hash().sign([{ keyPair }]).send(),
)
await step('wallet.read w1', () => sdk.wallet.read('w1'))
// The journal is written after the response; give it a moment.
await new Promise((r) => setTimeout(r, 3000))
const journal: any = await step('request.list (sdk)', () => sdk.request.list())
await raw('requests list without a token', 'GET', '/system/requests', { ledger: A, key: null })
await raw('requests list, stranger token', 'GET', '/system/requests', { ledger: A, key: stranger })
await raw('requests list on b, stranger token', 'GET', '/system/requests', { ledger: B, key: stranger })
await raw('requests list without x-ledger', 'GET', '/system/requests')
await raw('requests list by record', 'GET', '/system/requests?data.record=wallet:w1', { ledger: A })
await raw('requests list by action', 'GET', '/system/requests?data.action=create', { ledger: A })
const first = journal?.response?.data?.data?.[0]?.data?.handle ?? journal?.requests?.[0]?.handle
if (first) await step('request.read (sdk)', () => sdk.request.read(first))
await step('request.read missing', () => sdk.request.read('nope'))

// ---- drop ----------------------------------------------------------------------------

const sdkOf = (ledger: string, s = secure) => new LedgerSdk({ server: BASE, ledger, secure: { ...s, aud: ledger } })
const readB: any = await sdkOf(B).ledger.read()
const dropBody = async (ledger: string, parent: string, signers: (typeof keyPair)[], custom: Record<string, unknown> = {}) => {
  const data = { parent }
  const hash = createHash(data)
  const proofs = await Promise.all(signers.map((k) => signHash(hash, k, { moment: new Date().toISOString(), status: 'dropped', ...custom })))
  return { luid: readB.luid, hash, data, meta: { proofs } }
}
const hashB = readB.hash

await raw('ledger drop, wrong parent', 'DELETE', '/ledger', { ledger: B, body: await dropBody(B, '0'.repeat(64), [keyPair]) })
await raw('ledger drop, no proofs', 'DELETE', '/ledger', { ledger: B, body: { ...(await dropBody(B, hashB, [])), meta: { proofs: [] } } })
await raw('ledger drop by a stranger', 'DELETE', '/ledger', { ledger: B, key: stranger, body: await dropBody(B, hashB, [stranger]) })
await raw('ledger drop, no luid', 'DELETE', '/ledger', { ledger: B, body: { ...(await dropBody(B, hashB, [keyPair])), luid: undefined } })
await raw('ledger drop, no x-ledger', 'DELETE', '/ledger', { body: await dropBody(B, hashB, [keyPair]) })
await raw('ledger drop of b by POST', 'POST', '/ledger', { ledger: B, body: await dropBody(B, hashB, [keyPair], { reason: 'Ledger decommissioned' }) })
await raw('ledger read b after drop', 'GET', '/ledger', { ledger: B })
await raw('wallets list on b after drop', 'GET', '/wallets', { ledger: B })
// Does a list refuse, or keep only what the caller may read?
await step('wallet.create on b', () =>
  sdkOf(B).wallet.init().data({ handle: 'wb', access: [{ action: 'any', signer: { public: keyPair.public } }] } as any).hash().sign([{ keyPair }]).send(),
)
await raw('wallets list on b, owner token', 'GET', '/wallets', { ledger: B })
await raw('wallets list on b, stranger token', 'GET', '/wallets', { ledger: B, key: stranger })
await raw('wallet read on b, owner token', 'GET', '/wallets/wb', { ledger: B })
await step('wallet.create closed on a', () =>
  sdk.wallet.init().data({ handle: 'closed', access: [{ action: 'any', signer: { public: keyPair.public } }] } as any).hash().sign([{ keyPair }]).send(),
)
await raw('wallets list on a, stranger token', 'GET', '/wallets', { ledger: A, key: stranger })
await raw('wallets list on a, no token', 'GET', '/wallets', { ledger: A, key: null })
await raw('wallet read closed on a, stranger token', 'GET', '/wallets/closed', { ledger: A, key: stranger })
await raw('ledger drop of b again', 'DELETE', '/ledger', { ledger: B, body: await dropBody(B, hashB, [keyPair]) })
await step('ledger drop of c (sdk)', () => sdkOf(C).ledger.drop().hash().sign([{ keyPair }]).send())
await step('ledgers list after drops', () => root.ledger.list({ 'data.custom.run': RUN } as any))
await makeLedger(B, [{ action: 'any', signer: { public: keyPair.public } }])
await step('ledger.read b recreated', () => sdkOf(B).ledger.read())
await step('ledgers list after recreate', () => root.ledger.list({ 'data.custom.run': RUN } as any))
await raw('requests list after drops', 'GET', '/system/requests?data.action=drop', { ledger: A })
