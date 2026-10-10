// What `routes` and `anchors2` left open (TODO, Routes `(?)`): how deep credit routes
// may chain, the wording of a debit route cycle and of a route target that resolves to
// nothing; on anchor and domain calls to a bridge, whether its `secure` rules apply and
// whether its list's signature is checked; a lookup on a wallet without a bridge; and
// dropping a wallet with anchors while `anchor.walletRequired` is off.
//
// Every route here is resolved inside one intent: no route forwards to another, so
// nothing can loop on the sandbox (never-loop-on-sandbox). Chains end in a plain wallet.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { hashData } from '../../server/src/crypto.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, mine, LEDGER, secure } = await scenario()
const s: any = sdk
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const secKey = await createKeyPair()
const badKey = await createKeyPair()

// `bad` answers anchor lists itself: a wrong signature for one wallet, a wrong hash for another.
const anchorData = (w: string) => [{ handle: `tel:1@${w}`, wallet: w, target: `acc:1` }]
const badList = (path: string) => {
  const m = path.match(/^\/v2\/wallets\/([^/]+)\/anchors$/)
  if (!m) return undefined
  const data = anchorData(m[1])
  const hash = m[1] === 'bad-hash' ? '0'.repeat(64) : hashData(data)
  const proof = { method: 'ed25519-v2', public: badKey.public, digest: '1'.repeat(64), result: 'A'.repeat(86) + '==', custom: { moment: new Date().toISOString() } }
  return { status: 200, body: { hash, data, meta: { proofs: [proof] } } }
}

const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/routes2.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [
    {
      handle: 'sec',
      prefix: '/sec',
      keyPair: secKey,
      decide: () => ({ status: 'prepared' }),
      headers: ['x-api-key', 'authorization', 'x-ledger'],
      lists: (_m, path) => (path.includes('domain') ? [{ handle: 'branch@sec-w' }] : anchorData('sec-w')),
    },
    { handle: 'bad', prefix: '/bad', keyPair: badKey, decide: () => ({ status: 'prepared' }), serve: (_m, path) => badList(path) },
  ],
})
const bridge = (handle: string, data: Record<string, unknown>, secret?: Record<string, string>) =>
  step(`bridge.create ${handle}`, () =>
    s.bridge
      .init()
      .data({ handle, schema: 'rest', config: { server: `${BASE_URL}/${handle}/v2` }, access: mine, ...data })
      .meta({ proofs: [], ...(secret ? { secret } : {}) })
      .hash()
      .sign([{ keyPair }])
      .send(),
  )
await bridge('sec', { secure: [{ schema: 'header', key: 'X-API-Key', value: '{{ secret.apikey }}' }], traits: ['debits', 'credits', 'anchors', 'domains'] }, { apikey: 'anchor-key' })
await bridge('bad', { secure: [], traits: ['debits', 'credits', 'anchors'] })

await create('symbol', { handle: 'usd', factor: 100 })
for (const w of ['alice', 'bob', 'end']) await create('wallet', { handle: w })

// Credit routes chained: four hops (d1 → … → end) and three (e1 → … → end).
await create('wallet', { handle: 'd4', routes: [{ action: 'credit', target: 'end' }] })
await create('wallet', { handle: 'd3', routes: [{ action: 'credit', target: 'd4' }] })
await create('wallet', { handle: 'd2', routes: [{ action: 'credit', target: 'd3' }] })
await create('wallet', { handle: 'd1', routes: [{ action: 'credit', target: 'd2' }] })
await create('wallet', { handle: 'e3', routes: [{ action: 'credit', target: 'end' }] })
await create('wallet', { handle: 'e2', routes: [{ action: 'credit', target: 'e3' }] })
await create('wallet', { handle: 'e1', routes: [{ action: 'credit', target: 'e2' }] })
// A debit cycle (refused when resolved), and a route to an address that is nothing.
await create('wallet', { handle: 'dc2', routes: [{ action: 'debit', target: 'dc1' }] })
await create('wallet', { handle: 'dc1', routes: [{ action: 'debit', target: 'dc2' }] })
await create('wallet', { handle: 'lost', routes: [{ action: 'credit', target: 'nothing-here' }] })

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
async function settle(handle: string) {
  for (let i = 0; i < 40; i++) {
    try {
      const r: any = (await poller.intent.read(handle)).response.data
      if (['completed', 'rejected'].includes(r.meta.status)) return r.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
async function move(name: string, handle: string, claims: unknown[]) {
  await step(`intent.create ${name}`, () => sdk.intent.init().data({ handle, claims } as any).hash().sign([{ keyPair }]).send())
  console.log(`      settled: ${await settle(handle)}`)
  await step(`intent.read ${name}`, () => sdk.intent.read(handle))
}
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref('usd'), amount })

await move('fund', 'i-fund', [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 100 }])
await move('credit routes, four hops', 'i-depth4', [t('alice', 'd1', 1)])
await move('credit routes, three hops', 'i-depth3', [t('alice', 'e1', 1)])
await move('debit route cycle', 'i-dcycle', [t('dc1', 'bob', 1)])
await move('route to nothing', 'i-lost', [t('alice', 'lost', 1)])
for (const w of ['end', 'd1', 'e1']) await step(`balances ${w}`, () => sdk.wallet.getBalances(w))

// Anchor and domain calls to a bridge with a header rule; lists with a bad signature or hash.
await create('wallet', { handle: 'sec-w', bridge: 'sec' })
await create('wallet', { handle: 'bad-sig', bridge: 'bad' })
await create('wallet', { handle: 'bad-hash', bridge: 'bad' })
await step('wallet.anchors sec-w', () => s.wallet.getAnchors('sec-w'))
await step('wallet.domains sec-w', () => s.wallet.getDomains('sec-w'))
await step('wallet.anchors lookup sec-w', () => s.wallet.with('sec-w').anchor.lookup().data({ wallet: 'sec-w', target: 'acc:1' }).hash().sign([{ keyPair }]).send())
await step('wallet.anchors bad-sig', () => s.wallet.getAnchors('bad-sig'))
await step('wallet.anchors bad-hash', () => s.wallet.getAnchors('bad-hash'))

// A wallet without a bridge: a lookup by a field, then the wallet dropped with its anchors.
await create('wallet', { handle: 'plain' })
const anchor = (handle: string, target: string) =>
  step(`anchor.create ${handle}`, () => s.anchor.init().data({ handle, wallet: 'plain', target, access: mine }).hash().sign([{ keyPair }]).send())
await anchor('p-1', 'x:1')
await anchor('p-2', 'x:2')
await step('wallet.anchors lookup plain target x:1', () => s.wallet.with('plain').anchor.lookup().data({ wallet: 'plain', target: 'x:1' }).hash().sign([{ keyPair }]).send())
await step('wallet.anchors lookup plain handle p-2', () => s.wallet.with('plain').anchor.lookup().data({ wallet: 'plain', handle: 'p-2' }).hash().sign([{ keyPair }]).send())
await step('wallet.drop plain (anchors, walletRequired off)', () => s.wallet.drop('plain').hash().sign([{ keyPair }]).send())
await step('anchor.read p-1 after', () => s.anchor.read('p-1'))
await step('wallet.read plain after', () => s.wallet.read('plain'))

await new Promise((r) => setTimeout(r, 1000))
await bridges.close()
