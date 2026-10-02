// Bridges, second pass: how the ledger authenticates to a bridge (`secure`), when it
// gives up on a bridge that keeps failing, and which calls `traits` let through
// (about-bridges: "Bridge authentication", "Retries", "Filtering traits").
// Questions this records:
//
// - a `header` rule with a secret reference: what the bridge record looks like once the
//   ledger keeps the secret (`meta.secret` on create, as for signer factors), and what
//   header the bridge receives; a plain value where a reference is required
// - an `oauth2` rule: the token request (Basic auth, body), and whether the token is
//   cached across calls (`expires_in`)
// - a bridge answering 500 to every prepare: the retry cap (docs: 5 retries), the
//   delivery's status and reason once the ledger gives up, and `POST …/activate`
// - `traits` without `statuses` (no status notifications?) and a `credits` filter
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges, type Decision } from '../bridge.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, LEDGER, secure } = await scenario()
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const keys = Object.fromEntries(await Promise.all(['hdr', 'oa', 'down', 'tr'].map(async (h) => [h, await createKeyPair()] as const)))

let downIsDown = true
const prepared = (): Decision => ({ status: 'prepared' })
const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/secure.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [
    { handle: 'hdr', prefix: '/hdr', keyPair: keys.hdr, decide: prepared, headers: ['x-api-key', 'x-static', 'authorization'] },
    { handle: 'oa', prefix: '/oa', keyPair: keys.oa, decide: prepared, headers: ['authorization'], token: { access_token: 'token-one', token_type: 'Bearer', expires_in: 3600 } },
    { handle: 'down', prefix: '/down', keyPair: keys.down, decide: () => ({ httpWhile: 500, while: () => downIsDown, then: { status: 'prepared' } }) },
    { handle: 'tr', prefix: '/tr', keyPair: keys.tr, decide: prepared },
  ],
})

const mine = [{ action: 'any', signer: { public: keyPair.public } }]
const bridge = (handle: string, data: Record<string, unknown>, secret?: Record<string, string>) =>
  step(`bridge.create ${handle}`, () =>
    (sdk as any).bridge
      .init()
      .data({ handle, schema: 'rest', config: { server: `${BASE_URL}/${handle}/v2` }, secure: [], access: mine, ...data })
      .meta({ proofs: [], ...(secret ? { secret } : {}) })
      .hash()
      .sign([{ keyPair }])
      .send(),
  )
const signer = (handle: string) =>
  step(`signer.create ${handle}`, () =>
    (sdk as any).signer.init().data({ handle, public: keys[handle].public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send(),
  )

// A plain header value, where the schema asks for a secret reference.
await bridge('hdr-plain', { secure: [{ schema: 'header', key: 'X-API-Key', value: 'plain-value' }] })
// A reference whose secret is never given.
await bridge('hdr-nosecret', { secure: [{ schema: 'header', key: 'X-API-Key', value: '{{ secret.missing }}' }] })
await bridge(
  'hdr',
  {
    secure: [
      { schema: 'header', key: 'X-API-Key', value: '{{ secret.apiKey }}' },
      { schema: 'header', key: 'X-Static', value: '{{ secret.static }}' },
    ],
  },
  { apiKey: 'key-123', static: 'static-456' },
)
await bridge(
  'oa',
  { secure: [{ schema: 'oauth2', clientId: 'client-1', clientSecret: '{{ secret.oauth }}', tokenUrl: `${BASE_URL}/oa/oauth/token`, scope: 'ledger' }] },
  { oauth: 'client-secret-789' },
)
await bridge('down', {})
await bridge('tr', { traits: ['debits', { method: 'credits', filter: { amount: { $gte: 100 } } }] })
for (const h of ['hdr', 'oa', 'down', 'tr']) await signer(h)
await step('bridge.read hdr', () => (sdk as any).bridge.read('hdr'))
await step('bridge.read oa', () => (sdk as any).bridge.read('oa'))

await create('symbol', { handle: 'usd', factor: 100 })
for (const [w, b] of [['alice'], ['acct-hdr', 'hdr'], ['acct-oa', 'oa'], ['acct-down', 'down'], ['acct-tr', 'tr']])
  await create('wallet', { handle: w, ...(b ? { bridge: b } : {}) })

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
async function settle(handle: string, seconds = 40) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const r: any = (await poller.intent.read(handle)).response.data
      if (['completed', 'rejected'].includes(r.meta.status)) return r.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
const send = (name: string, handle: string, claims: unknown[]) =>
  step(`intent.create ${name}`, () => sdk.intent.init().data({ handle, claims } as any).hash().sign([{ keyPair }]).send())
async function move(name: string, handle: string, claims: unknown[]) {
  await send(name, handle, claims)
  console.log(`      settled: ${await settle(handle)}`)
  await step(`intent.read ${name}`, () => sdk.intent.read(handle))
}
const usd = ref('usd')
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: usd, amount })

await move('fund', 'i-fund', [
  { action: 'issue', target: ref('alice'), symbol: usd, amount: 1000 },
  { action: 'issue', target: ref('acct-tr'), symbol: usd, amount: 500 },
])
await move('header rules', 'i-hdr', [t('alice', 'acct-hdr', 1)])
await move('oauth2', 'i-oa-1', [t('alice', 'acct-oa', 2)])
await move('oauth2 again (cached token?)', 'i-oa-2', [t('alice', 'acct-oa', 3)])
await move('traits: filtered-out credit', 'i-tr-small', [t('alice', 'acct-tr', 5)])
await move('traits: credit', 'i-tr-big', [t('alice', 'acct-tr', 150)])
await move('traits: debit', 'i-tr-debit', [t('acct-tr', 'alice', 7)])

// A bridge that answers 500 until it is "back": watch the deliveries give up.
await send('bridge down', 'i-down', [t('alice', 'acct-down', 4)])
const events = (sdk as any).bridge.with('down').events
const directEvents = () => (new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure }) as any).bridge.with('down').events
// Given up: nothing changed for 16 s (retries come at most ~2 s apart before a cap of 5).
let last = ''
let still = 0
for (let i = 0; i < 60 && still < 8; i++) {
  const rows = (await directEvents().list({ 'data.linked': 'i-down' } as any)).response.data.data as any[]
  const now = rows.map((d) => `${d.meta.status}/${d.meta.replay}`).join(' ')
  still = now === last && rows.length ? still + 1 : 0
  last = now
  await new Promise((r) => setTimeout(r, 2000))
}
console.log(`      deliveries of i-down: ${last}`)
await step('events.list of i-down', () => events.list({ 'data.linked': 'i-down' }))
await step('intent.read bridge down', () => sdk.intent.read('i-down'))
downIsDown = false
await step('bridge.activate down', () => (sdk as any).bridge.with('down').activate({ maxAge: 0 }).hash().sign([{ keyPair }]).send())
console.log(`      settled: ${await settle('i-down', 60)}`)
await step('intent.read bridge down, after activate', () => sdk.intent.read('i-down'))
await step('events.list of i-down, after activate', () => events.list({ 'data.linked': 'i-down' }))

for (const w of ['alice', 'acct-hdr', 'acct-oa', 'acct-down', 'acct-tr']) await step(`balances ${w}`, () => sdk.wallet.getBalances(w))

await new Promise((r) => setTimeout(r, 3000))
await bridges.close()
