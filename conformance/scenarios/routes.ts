// Addresses and wallet routes (docs: about-wallets). An address `schema:handle@parent`
// that is no wallet resolves up the hierarchy `schema:handle@parent → schema@parent →
// parent → schema`; routes redirect a claim's debit or credit, accept it by filter, or
// forward the credit in a new intent of the same thread. A bridge `hpb` owns wallet
// `hpb`, so what it is sent for an address (the address or the wallet?) is recorded.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, LEDGER, secure } = await scenario()
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const hpbKey = await createKeyPair()

const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/routes.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [{ handle: 'hpb', prefix: '/hpb', keyPair: hpbKey, decide: () => ({ status: 'prepared' }) }],
})
const mine = [{ action: 'any', signer: { public: keyPair.public } }]
await step('bridge.create hpb', () =>
  (sdk as any).bridge.init().data({ handle: 'hpb', schema: 'rest', config: { server: `${BASE_URL}/hpb/v2` }, secure: [], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create hpb', () =>
  (sdk as any).signer.init().data({ handle: 'hpb', public: hpbKey.public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send(),
)

await create('symbol', { handle: 'usd', factor: 100 })
await create('symbol', { handle: 'eur', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'bob' })
await create('wallet', { handle: 'hpb', bridge: 'hpb' })
await create('wallet', { handle: 'tel' })
await create('wallet', { handle: 'loan@hpb' })
await create('wallet', { handle: 'acc-eur', routes: [{ action: 'accept', filter: { 'symbol.handle': 'eur' } }] })
await create('wallet', { handle: 'collector', routes: [{ action: 'credit', target: 'alice' }] })
await create('wallet', { handle: 'payer', routes: [{ action: 'debit', target: 'alice' }] })
await create('wallet', { handle: 'fwd', routes: [{ action: 'forward', target: 'bob' }] })
await create('wallet', { handle: 'eur-out', routes: [{ action: 'debit', target: 'eur-out', filter: { 'symbol.handle': 'eur' } }] })
await create('wallet', { handle: 'cyc2', routes: [{ action: 'credit', target: 'cyc1' }] })
await create('wallet', { handle: 'cyc1', routes: [{ action: 'credit', target: 'cyc2' }] })
await create('wallet', { handle: 'tel:777', routes: [{ action: 'credit', target: 'account:5@hpb' }] })
await step('wallet.read by address', () => sdk.wallet.read('account:1050000029@hpb'))

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
async function settle(handle: string) {
  for (let i = 0; i < 80; i++) {
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
const t = (source: string, target: string, amount: number, symbol = 'usd') => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref(symbol), amount })
const issue = (target: string, amount: number, symbol = 'usd') => ({ action: 'issue', target: ref(target), symbol: ref(symbol), amount })

await move('fund', 'i-fund', [issue('alice', 1000), issue('alice', 100, 'eur'), issue('bob', 100)])
await move('to a bank account address', 'i-account', [t('alice', 'account:1050000029@hpb', 10)])
await move('to a phone address', 'i-tel', [t('alice', 'tel:15261234578', 5)])
await move('to schema@parent', 'i-loan', [t('alice', 'loan:42@hpb', 3)])
await move('to an unknown parent', 'i-zaba', [t('alice', '41111339@zaba', 1)])
await move('to an unknown schema', 'i-acct', [t('alice', 'acct:1', 1)])
await move('from a bank account address', 'i-from-account', [t('account:9@hpb', 'alice', 4)])
await move('issue to an address', 'i-issue-tel', [issue('tel:888', 5)])
await move('accept route refuses usd', 'i-accept-usd', [t('alice', 'acc-eur', 2)])
await move('accept route takes eur', 'i-accept-eur', [t('alice', 'acc-eur', 2, 'eur')])
await move('credit route', 'i-credit', [t('bob', 'collector', 6)])
await move('debit route', 'i-debit', [t('payer', 'bob', 7)])
await move('forward route', 'i-forward', [t('alice', 'fwd', 8)])
await move('unmatched input route', 'i-eur-out', [t('eur-out', 'bob', 1)])
await move('route cycle', 'i-cycle', [t('alice', 'cyc1', 1)])
await move('route to a bridged address', 'i-chain', [t('alice', 'tel:777', 2)])
// The forward route's own intent, if there is one, is the newest.
await step('intent.list', () => sdk.intent.list({ page: { index: 0, limit: 3 } } as any))

for (const w of ['alice', 'bob', 'hpb', 'tel', 'loan@hpb', 'acc-eur', 'collector', 'payer', 'fwd', 'tel:777']) await step(`balances ${w}`, () => sdk.wallet.getBalances(w))

await new Promise((r) => setTimeout(r, 3000))
await bridges.close()
