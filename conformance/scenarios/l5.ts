// L5: two-phase commit with one external participant. A bridge `bank` owns wallet
// `acc`; alice is a wallet of the ledger itself. Money moves both ways, a prepare
// fails, a prepare call fails over HTTP once (retry), and an issue targets the bridged
// wallet. The bridge (conformance/bridge.ts) records every call the ledger makes to it.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridge } from '../bridge.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, LEDGER, secure } = await scenario()
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2'
const bankKey = await createKeyPair()

const bridge = await startBridge({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/l5.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  handle: 'bank',
  keyPair: bankKey,
  decide: (entry) => {
    const intent = entry?.intent?.data?.handle
    if (intent === 'i-fail') return { status: 'failed', reason: 'bridge.unexpected-error', detail: 'Account acc is closed' }
    if (intent === 'i-retry') return { httpFirst: 500, then: { status: 'prepared' } }
    return { status: 'prepared' }
  },
})

await step('bridge.create bank', () =>
  (sdk as any).bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: BRIDGE_URL }, secure: [], access: [{ action: 'any', signer: { public: keyPair.public } }] }).hash().sign([{ keyPair }]).send(),
)
await step('bridge.read bank', () => (sdk as any).bridge.read('bank'))
await step('signer.create bank', () =>
  (sdk as any).signer.init().data({ handle: 'bank', public: bankKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send(),
)
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'acc', bridge: 'bank' })

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
async function settle(handle: string) {
  for (let i = 0; i < 180; i++) {
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
const usd = ref('usd')
await move('fund alice', 'i-fund', [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 100 }])
await move('out to bank', 'i-out', [{ action: 'transfer', source: ref('alice'), target: ref('acc'), symbol: usd, amount: 10 }])
await move('in from bank', 'i-in', [{ action: 'transfer', source: ref('acc'), target: ref('alice'), symbol: usd, amount: 5 }])
await move('bank fails prepare', 'i-fail', [{ action: 'transfer', source: ref('alice'), target: ref('acc'), symbol: usd, amount: 7 }])
await move('prepare retried', 'i-retry', [{ action: 'transfer', source: ref('alice'), target: ref('acc'), symbol: usd, amount: 3 }])
await move('issue to bank wallet', 'i-issue-acc', [{ action: 'issue', target: ref('acc'), symbol: usd, amount: 50 }])
await step('balances alice', () => sdk.wallet.getBalances('alice'))
await step('balances acc', () => sdk.wallet.getBalances('acc'))

// Late proofs from the bridge land in its log; give them a moment before closing.
await new Promise((r) => setTimeout(r, 3000))
await bridge.close()
