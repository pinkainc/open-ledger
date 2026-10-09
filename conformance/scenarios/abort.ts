// Abort with a bridge that has not confirmed it yet (v2.47.0: "Fixes reserved balances
// staying held on aborted intents while bridges have not confirmed the abort"). alice
// is a wallet of the ledger, acc belongs to bridge bank. The bank refuses the credit
// of i-held and holds its `aborted` report back: alice's balance is read while the
// intent waits for it, then after it arrives. i-never's abort is never confirmed.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { LedgerSdk } from '@minka/ledger-sdk'
import { startBridge } from '../bridge.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, intent, mine, LEDGER, secure } = await scenario()
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2'
const bankKey = await createKeyPair()

const bridge = await startBridge({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/abort.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  handle: 'bank',
  keyPair: bankKey,
  decide: () => ({ status: 'failed', reason: 'bridge.unexpected-error', detail: 'Account acc is closed' }),
  report: (_entry, action, i) => (action === 'abort' ? (i?.data?.handle === 'i-never' ? false : 'hold') : true),
})

await step('bridge.create bank', () =>
  (sdk as any).bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: BRIDGE_URL }, secure: [], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create bank', () =>
  (sdk as any).signer.init().data({ handle: 'bank', public: bankKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send(),
)
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'acc', bridge: 'bank' })
const usd = ref('usd')
await intent('fund alice', 'i-fund', [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 100 }])

const direct: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
async function until(handle: string, status: string) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await direct.intent.read(handle)).response.data.meta.status === status) return status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}

const move = (handle: string) =>
  step(`intent.create ${handle}`, () =>
    sdk.intent.init().data({ handle, claims: [{ action: 'transfer', source: ref('alice'), target: ref('acc'), symbol: usd, amount: 10 }], access: mine } as any).hash().sign([{ keyPair }]).send(),
  )

await move('i-held')
console.log(`      reached: ${await until('i-held', 'aborted')}`)
// A moment for anything the reference does right after `aborted`.
await new Promise((r) => setTimeout(r, 3000))
await step('intent.read i-held (abort unconfirmed)', () => sdk.intent.read('i-held'))
await step('balances alice (abort unconfirmed)', () => sdk.wallet.getBalances('alice'))
await bridge.release()
console.log(`      reached: ${await until('i-held', 'rejected')}`)
await step('intent.read i-held (abort confirmed)', () => sdk.intent.read('i-held'))
await step('balances alice (abort confirmed)', () => sdk.wallet.getBalances('alice'))

await move('i-never')
console.log(`      reached: ${await until('i-never', 'aborted')}`)
await new Promise((r) => setTimeout(r, 3000))
await step('intent.read i-never', () => sdk.intent.read('i-never'))
await step('balances alice (never confirmed)', () => sdk.wallet.getBalances('alice'))

await new Promise((r) => setTimeout(r, 2000))
await bridge.close()
