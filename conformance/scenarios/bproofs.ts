// Who may report on a bridge's entry. The docs (about-intents): a signer adding a proof
// with `custom.handle` "must have granted action sign for record intent on the bridge
// record which is related to the entry". The bridge here never reports by itself
// (`silent`); the scenario sends its `prepared` from different keys, one intent each,
// and reads whether the intent moves on (commit call to the bridge) or stays.
//
// The ledger is not open: only the operator may change records, everyone may enter and read.
// Keys: the bridge's own (first without, then with the rule on its bridge record), the
// operator (owns the ledger), a registered signer with no rights, a stranger.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridge } from '../bridge.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, LEDGER, BASE } = await scenario({
  access: (op) => [
    { action: 'any', signer: { public: op } },
    { action: 'any', record: 'any', signer: { public: op } },
    { action: 'access' },
    { action: 'read', record: 'any' },
  ],
})
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2'
const bankKey = await createKeyPair()
const otherKey = await createKeyPair()
const strangerKey = await createKeyPair()

// The credit entry of each intent as the bridge received it.
const entries = new Map<string, any>()
const bridge = await startBridge({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/bproofs.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  handle: 'bank',
  keyPair: bankKey,
  decide: (entry) => {
    entries.set(entry?.intent?.data?.handle, entry)
    return { silent: true }
  },
})

const owner = { action: 'any', signer: { public: keyPair.public } }
const bridgeData = (access: unknown[]) => ({ handle: 'bank', schema: 'rest', config: { server: BRIDGE_URL }, secure: [], access })
await step('bridge.create bank', () => (sdk as any).bridge.init().data(bridgeData([owner])).hash().sign([{ keyPair }]).send())
await step('signer.create bank', () =>
  (sdk as any).signer.init().data({ handle: 'bank', public: bankKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create other', () =>
  (sdk as any).signer.init().data({ handle: 'other', public: otherKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send(),
)
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'acc', bridge: 'bank' })

const sdkOf = (k: any) =>
  new LedgerSdk({ server: BASE, ledger: LEDGER, secure: { iss: k.public, sub: `signer:${k.public}`, aud: LEDGER, exp: 3600, createHsh: false, kid: k.public, keyPair: k } as any }) as any
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const usd = ref('usd')
await step('intent.create fund', () =>
  sdk.intent.init().data({ handle: 'i-fund', claims: [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 100 }] } as any).hash().sign([{ keyPair }]).send(),
)
await wait(3000)

/** One intent alice → acc; the bridge's credit entry gets a `prepared` from `key`. */
async function attempt(name: string, handle: string, key: any) {
  await step(`intent.create ${name}`, () =>
    sdk.intent.init().data({ handle, claims: [{ action: 'transfer', source: ref('alice'), target: ref('acc'), symbol: usd, amount: 1 }] } as any).hash().sign([{ keyPair }]).send(),
  )
  for (let i = 0; i < 40 && !entries.has(handle); i++) await wait(500)
  const entry = entries.get(handle)
  console.log(`      credit call: ${entry ? 'received' : 'none'}`)
  if (!entry) return
  await step(`proof ${name}`, () =>
    sdkOf(key).intent.from(entry.intent).sign([{ keyPair: key, custom: { handle: entry.handle, status: 'prepared', coreId: 'core-1', moment: new Date().toISOString() } }]).send(),
  )
  await wait(5000)
  // Read through the proxy: whether the intent moved on is the point.
  await step(`intent.read ${name}`, () => sdk.intent.read(handle))
}

await attempt('bridge key, no rule', 'i-bank0', bankKey)
await attempt('operator', 'i-op', keyPair)
await attempt('registered signer', 'i-other', otherKey)
await attempt('stranger', 'i-stranger', strangerKey)

// The rule the docs ask for, on the bridge record: refused, `sign` is no action. The
// first recording then tried `{any, record: intent}` on the bridge, `{any}` on the
// bridge and on the wallet, `{update|any, record: intent}` on the ledger: the bridge's
// key was refused each time, with the same three errors. What the operator has and
// those lack is `record: any`; adding a proof is checked as `intent-proof`.
const bridgeRule = (name: string, rule: unknown) =>
  step(`bridge.update bank ${name}`, async () => {
    const b: any = (await (sdk as any).bridge.read('bank')).response.data
    return (sdk as any).bridge.from(b).data(bridgeData([owner, rule])).hash().sign([{ keyPair }]).send()
  })
const bank = { public: bankKey.public }
await bridgeRule('{sign, record: intent}', { action: 'sign', record: 'intent', signer: bank })
await bridgeRule('{any, record: intent-proof}', { action: 'any', record: 'intent-proof', signer: bank })
await attempt('bridge key, bridge rule {any, record: intent-proof}', 'i-b1', bankKey)
const ledgerRule = (name: string, rule: unknown) =>
  step(`ledger.update ${name}`, async () => {
    const l: any = (await (sdk as any).ledger.read()).response.data
    return (sdk as any).ledger.from(l).data({ access: [...l.data.access, rule] }).hash().sign([{ keyPair }]).send()
  })
await ledgerRule('{any, record: intent} for bank', { action: 'any', record: 'intent', signer: bank })
await attempt('bridge key, ledger {any, record: intent}', 'i-b2', bankKey)
await ledgerRule('{create, record: intent-proof} for bank', { action: 'create', record: 'intent-proof', signer: bank })
await attempt('bridge key, ledger {create, record: intent-proof}', 'i-b3', bankKey)
await ledgerRule('{any, record: intent-proof} for bank', { action: 'any', record: 'intent-proof', signer: bank })
await attempt('bridge key, ledger {any, record: intent-proof}', 'i-b4', bankKey)
await attempt('registered signer, after the rules', 'i-other2', otherKey)

await wait(3000)
await bridge.close()
