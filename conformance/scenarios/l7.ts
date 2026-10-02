// L7: threads. A `forward` route makes a new intent in the thread of the one that
// credited the wallet (routes). The docs say a thread commits atomically and that an
// expired intent aborts its whole thread (about-intents, intent-expiry); the routes
// recording showed the first intent completing before its forward intent was even
// processed. Questions this records:
//
// - a forward intent that fails resolution (route target refuses the claim)
// - a forward intent whose bridge fails the prepare
// - a forward intent whose bridge never answers: does it expire, and what happens to
//   the intent that made it (already completed?) — "thread abort"
// - a forward intent that succeeds through a bridge (baseline)
//
// Not here: two wallets forwarding to each other. Recorded once (2026-10-02): the
// reference checks the thread size only after the fact and made ~5000 intents before
// the loop was broken by hand. Unbounded cases are tested against our server only.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges, type Decision } from '../bridge.js'
import { ref, scenario } from './common.js'

// A one-minute expiry, so the silent forward is aborted within the run.
const { sdk, keyPair, step, create, LEDGER, secure } = await scenario({ expiryMinutes: 1 })
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const bankKey = await createKeyPair()

// The forward intent names the intent that made it in `data.origin`.
const originOf = (entry: any) => entry?.intent?.data?.origin as string | undefined
const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/l7.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [
    {
      handle: 'bank',
      prefix: '/bank',
      keyPair: bankKey,
      decide: (entry): Decision => {
        if (originOf(entry) === 'i-fwd-fail') return { status: 'failed', reason: 'bridge.unexpected-error', detail: 'Account closed' }
        if (originOf(entry) === 'i-fwd-silent') return { silent: true }
        return { status: 'prepared' }
      },
    },
  ],
})

const mine = [{ action: 'any', signer: { public: keyPair.public } }]
await step('bridge.create bank', () =>
  (sdk as any).bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: `${BASE_URL}/bank/v2` }, secure: [], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create bank', () =>
  (sdk as any).signer.init().data({ handle: 'bank', public: bankKey.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send(),
)
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'strict', routes: [{ action: 'accept', filter: { 'symbol.handle': 'eur' } }] })
await create('wallet', { handle: 'acct-ok', bridge: 'bank' })
await create('wallet', { handle: 'acct-fail', bridge: 'bank' })
await create('wallet', { handle: 'acct-silent', bridge: 'bank' })
await create('wallet', { handle: 'fwd-strict', routes: [{ action: 'forward', target: 'strict' }] })
await create('wallet', { handle: 'fwd-ok', routes: [{ action: 'forward', target: 'acct-ok' }] })
await create('wallet', { handle: 'fwd-fail', routes: [{ action: 'forward', target: 'acct-fail' }] })
await create('wallet', { handle: 'fwd-silent', routes: [{ action: 'forward', target: 'acct-silent' }] })

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
const FINAL = ['completed', 'rejected']
const all = async (): Promise<any[]> => {
  const r: any = await poller.intent.list({ page: { index: 0, limit: 50 } } as any)
  return (r?.response?.data?.data ?? []) as any[]
}
// The thread an intent starts, following `data.origin`, oldest first.
async function thread(first: string) {
  const list = await all()
  const out: any[] = []
  let at = list.find((i) => i.data.handle === first)
  while (at) {
    out.push(at)
    const h = at.data.handle
    at = list.find((i) => i.data.origin === h)
  }
  return out
}
// Settled: every intent of the thread final, and no intent waiting to be made.
async function settle(first: string, seconds = 40) {
  let last = ''
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const t = await thread(first)
      const now = t.map((x) => x.meta.status).join(' ')
      if (t.length && t.every((x) => FINAL.includes(x.meta.status)) && now === last) return now
      last = now
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return `timeout (${last})`
}
const send = (name: string, handle: string, claims: unknown[]) =>
  step(`intent.create ${name}`, () => sdk.intent.init().data({ handle, claims } as any).hash().sign([{ keyPair }]).send())
// Reads every intent of the thread on the record, oldest first.
async function readThread(name: string, first: string) {
  const t = await thread(first)
  console.log(`      ${name}: ${t.length} intent(s)`)
  for (const [n, i] of t.slice(0, 15).entries()) await step(`intent.read ${name} #${n}`, () => sdk.intent.read(i.data.handle))
}
async function move(name: string, handle: string, claims: unknown[]) {
  await send(name, handle, claims)
  console.log(`      settled: ${await settle(handle)}`)
  await readThread(name, handle)
}
const usd = ref('usd')
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: usd, amount })

await move('fund', 'i-fund', [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 1000 }])
await move('forward, route refuses', 'i-fwd-strict', [t('alice', 'fwd-strict', 3)])
await move('forward, bridge fails the prepare', 'i-fwd-fail', [t('alice', 'fwd-fail', 4)])
await move('forward, bridge prepares', 'i-fwd-ok', [t('alice', 'fwd-ok', 6)])
// Last, because what follows it differs on purpose: the reference never expires this
// thread (observed: still pending after nine minutes), we do (a minute is a second
// here). Read after a fixed wait.
await send('forward, bridge never answers', 'i-fwd-silent', [t('alice', 'fwd-silent', 5)])
console.log(`      i-fwd-silent settled: ${await settle('i-fwd-silent', 90)}`)
await readThread('forward, bridge never answers', 'i-fwd-silent')

for (const w of ['alice', 'strict', 'acct-ok', 'acct-fail', 'acct-silent', 'fwd-strict', 'fwd-ok', 'fwd-fail', 'fwd-silent'])
  await step(`balances ${w}`, () => sdk.wallet.getBalances(w))

await new Promise((r) => setTimeout(r, 3000))
await bridges.close()
