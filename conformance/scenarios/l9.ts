// L9: two ledgers joined by a bridge (connecting-systems/cross-ledger-payments). The
// scenario's ledger is the clearing house; a second one, `<ledger>-mint`, is the core of
// the bank `mint`. In the clearing house, wallet `mint` has the bridge `mint`, which is
// bridges/ledger-bridge: every debit and credit of `x@mint` it carries out as intents in
// the bank's ledger (prepare debit: account → transit; commit: destroy; credit commit:
// issue). The bank's supply then always equals the clearing house's `mint` balance.
//
// Covered: a top-up of the bank's own wallet, payments out and in, an out payment the
// bank refuses (insufficient balance), a credit to an account the bank does not have,
// an intent aborted after the bank prepared its debit (the hold is undone), and the
// tutorial's alias: `tel:…` forwards to `account:…@mint`.
//
// No loops: the adapter writes only to the bank's ledger, and that ledger has no bridge.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
// footprint-ledger: -mint
import { appendFileSync } from 'node:fs'
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { LedgerBridge } from '../../bridges/ledger-bridge/src/index.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, LEDGER, BASE, secure } = await scenario()
const DIRECT = (process.env.DIRECT ?? BASE)!
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2'
const OUT = process.env.BRIDGE_OUT ?? '.rec/l9.bridge.jsonl'
const CORE = `${LEDGER}-mint`
const mintKey = await createKeyPair()

// The bank's ledger, made by the same operator; the bridge's key may act on its records.
await step('ledger.create core', () =>
  new LedgerSdk({ server: BASE, secure: { ...secure, aud: CORE } })
    .ledger.init()
    .data({ handle: CORE, signer: 'system', config: { 'intent.expiryThresholdMinutes': 60, 'access.strategy': 'record-based' }, access: [{ action: 'any', record: 'any' }] } as any)
    .hash()
    .sign([{ keyPair }])
    .send(),
)
const core = new LedgerSdk({ server: BASE, ledger: CORE, secure: { ...secure, aud: CORE } })
const both = [{ action: 'any', signer: { public: keyPair.public } }, { action: 'any', signer: { public: mintKey.public } }]
const inCore = (client: 'symbol' | 'wallet', data: Record<string, unknown>) =>
  step(`core ${client}.create ${data.handle}`, () => (core as any)[client].init().data({ access: both, ...data }).hash().sign([{ keyPair }]).send())

let seq = 0
const bridge = new LedgerBridge({
  handle: 'mint',
  keyPair: mintKey,
  upstream: { server: DIRECT, ledger: LEDGER },
  downstream: { server: DIRECT, ledger: CORE },
  wallet: 'mint',
  log: (x) => appendFileSync(OUT, JSON.stringify({ seq: seq++, ...x }) + '\n'),
})
await bridge.listen(Number(process.env.BRIDGE_PORT ?? 4630))

// The clearing house.
await step('bridge.create mint', () =>
  (sdk as any).bridge.init().data({ handle: 'mint', schema: 'rest', config: { server: BRIDGE_URL }, secure: [], access: [{ action: 'any', signer: { public: keyPair.public } }] }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create mint', () =>
  (sdk as any).signer.init().data({ handle: 'mint', public: mintKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send(),
)
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'ach' })
await create('wallet', { handle: 'tesla' })
await create('wallet', { handle: 'mint', bridge: 'mint' })
await create('wallet', { handle: 'tel:13334444333', routes: [{ action: 'forward', target: 'account:1001001212@mint', filter: { 'symbol.handle': 'usd' } }] })

// The bank.
await inCore('symbol', { handle: 'usd', factor: 100 })
for (const w of ['treasury', 'transit', 'account:1001001212', 'account:1001009999']) await inCore('wallet', { handle: w })

const poll = (ledger: string): any => new LedgerSdk({ server: DIRECT, ledger, secure: { ...secure, aud: ledger } })
async function settle(ledger: string, handle: string) {
  for (let i = 0; i < 120; i++) {
    try {
      const r: any = (await poll(ledger).intent.read(handle)).response.data
      if (['completed', 'rejected'].includes(r.meta.status)) return r.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
async function move(name: string, handle: string, claims: unknown[], on: any = sdk, ledger = LEDGER) {
  await step(`intent.create ${name}`, () => on.intent.init().data({ handle, claims } as any).hash().sign([{ keyPair }]).send())
  console.log(`      settled: ${await settle(ledger, handle)}`)
  // The bridge's last proof (commit or abort) may land after the status the poll saw.
  await bridge.idle()
  await step(`intent.read ${name}`, () => on.intent.read(handle))
}
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref('usd'), amount })

await move('fund', 'i-fund', [{ action: 'issue', target: ref('ach'), symbol: ref('usd'), amount: 1000 }, { action: 'issue', target: ref('tesla'), symbol: ref('usd'), amount: 200 }])
await move('top up the bank', 'i-topup', [t('ach', 'mint', 500)])
await move('bank funds an account', 'b-fund', [t('treasury', 'account:1001001212', 100)], core, CORE)
await move('pay out of the bank', 'i-out', [t('account:1001001212@mint', 'tesla', 30)])
await move('pay into the bank', 'i-in', [t('tesla', 'account:1001009999@mint', 12)])
await move('bank refuses: insufficient balance', 'i-nsf', [t('account:1001009999@mint', 'tesla', 50)])
await move('bank refuses: no such account', 'i-noacct', [t('tesla', 'account:404@mint', 5)])
await move('debit prepared, then aborted', 'i-abort', [t('account:1001001212@mint', 'tesla', 10), t('tesla', 'account:404@mint', 1)])
await move('alias forwards into the bank', 'i-alias', [t('tesla', 'tel:13334444333', 7)])

// The forward intent finishes after i-alias; wait for the bank's account to show it.
for (let i = 0; i < 60; i++) {
  const b: any = await poll(CORE).wallet.getBalances('account:1001001212').catch(() => undefined)
  const usd = b?.response?.data?.data?.find?.((x: any) => x.symbol === 'usd')?.amount
  if (usd === 77) break
  await new Promise((r) => setTimeout(r, 500))
}
await bridge.idle()

for (const w of ['ach', 'tesla', 'mint']) await step(`balances ${w}`, () => sdk.wallet.getBalances(w))
for (const w of ['treasury', 'transit', 'account:1001001212', 'account:1001009999']) await step(`core balances ${w}`, () => core.wallet.getBalances(w))
await step('core intent.list', () => core.intent.list())

await new Promise((r) => setTimeout(r, 2000))
await bridge.close()
