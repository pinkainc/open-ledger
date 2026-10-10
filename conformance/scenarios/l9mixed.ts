// L9 mixed: open-ledger and Minka joined by bridges/ledger-bridge, both ways.
//
//   1. The reference is the clearing house (the scenario's ledger); the bank's core is a
//      ledger on our server (LOCAL). The reference calls the bridge through the tunnel.
//   2. Our server is the clearing house; the bank's core is a ledger on the reference,
//      `<ledger>-core`. Our server calls a second bridge directly.
//
// Recorded: what goes to the reference (both its ledgers). Checked: the same against our
// server, which then plays both parts. Each part ends by checking that the bank's
// supply equals the clearing house's `mint` balance (`mirror … ok`).
//
// No loops: each bridge only writes downstream, and neither bank ledger has a bridge.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
// needs-local-server — run.sh starts our server at LOCAL when recording, too.
// footprint-ledger: -core
import { appendFileSync } from 'node:fs'
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { LedgerBridge } from '../../bridges/ledger-bridge/src/index.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, LEDGER, BASE, secure } = await scenario()
const RUN = process.env.RUN ?? 'local'
const DIRECT = (process.env.DIRECT ?? BASE)!
const LOCAL = process.env.LOCAL ?? 'http://127.0.0.1:4620/api/v2'
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2'
const OUT = process.env.BRIDGE_OUT ?? '.rec/l9mixed.bridge.jsonl'
const REMOTE_CORE = `${LEDGER}-core`
const LOCAL_CLEARING = `l9mixed-clearing-${RUN}`
const LOCAL_CORE = `l9mixed-core-${RUN}`

const sdkOn = (server: string, ledger?: string): any => new LedgerSdk({ server, ledger, secure: { ...secure, aud: ledger ?? 'unknown' } })
const makeLedger = (server: string, handle: string) =>
  sdkOn(server, undefined)
    .ledger.init()
    .data({ handle, signer: 'system', config: { 'intent.expiryThresholdMinutes': 60, 'access.strategy': 'record-based' }, access: [{ action: 'any', record: 'any' }] } as any)
    .hash()
    .sign([{ keyPair }])
    .send()
const sign = (on: any, kind: string, data: any) => on[kind].init().data(data).hash().sign([{ keyPair }]).send()
// Steps against our server are not on the record (they are not the reference's); they throw.
const quiet = async (fn: () => Promise<unknown>) => {
  await fn()
}

async function clearing(on: any, name: string, mintKey: any, bridgeUrl: string, run: (n: string, f: () => Promise<unknown>) => Promise<unknown>) {
  await run(`${name} bridge.create mint`, () => sign(on, 'bridge', { handle: 'mint', schema: 'rest', config: { server: bridgeUrl }, secure: [], access: [{ action: 'any', signer: { public: keyPair.public } }] }))
  await run(`${name} signer.create mint`, () => sign(on, 'signer', { handle: 'mint', public: mintKey.public, format: 'ed25519-raw' }))
  await run(`${name} symbol.create usd`, () => sign(on, 'symbol', { handle: 'usd', factor: 100 }))
  for (const w of ['ach', 'tesla']) await run(`${name} wallet.create ${w}`, () => sign(on, 'wallet', { handle: w }))
  await run(`${name} wallet.create mint`, () => sign(on, 'wallet', { handle: 'mint', bridge: 'mint' }))
}
async function bank(on: any, name: string, mintKey: any, run: (n: string, f: () => Promise<unknown>) => Promise<unknown>) {
  const both = [{ action: 'any', signer: { public: keyPair.public } }, { action: 'any', signer: { public: mintKey.public } }]
  await run(`${name} symbol.create usd`, () => sign(on, 'symbol', { handle: 'usd', factor: 100, access: both }))
  for (const w of ['treasury', 'transit', 'account:1', 'account:2']) await run(`${name} wallet.create ${w}`, () => sign(on, 'wallet', { handle: w, access: both }))
}

async function settle(server: string, ledger: string, handle: string) {
  for (let i = 0; i < 120; i++) {
    try {
      const r: any = (await sdkOn(server, ledger).intent.read(handle)).response.data
      if (['completed', 'rejected'].includes(r.meta.status)) return r.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: ref('usd'), amount })
const flows: [string, string, unknown[]][] = [
  ['fund', 'i-fund', [{ action: 'issue', target: ref('ach'), symbol: ref('usd'), amount: 1000 }, { action: 'issue', target: ref('tesla'), symbol: ref('usd'), amount: 100 }]],
  ['top up the bank', 'i-topup', [t('ach', 'mint', 300)]],
  ['pay into the bank', 'i-in', [t('tesla', 'account:1@mint', 40)]],
  ['pay out of the bank', 'i-out', [t('account:1@mint', 'tesla', 15)]],
  ['bank refuses: insufficient balance', 'i-nsf', [t('account:2@mint', 'tesla', 5)]],
  ['debit prepared, then aborted', 'i-abort', [t('account:1@mint', 'tesla', 10), t('tesla', 'account:404@mint', 1)]],
]

async function balance(server: string, ledger: string, wallet: string) {
  const r: any = await sdkOn(server, ledger).wallet.getBalances(wallet)
  return (r.response.data.data as any[]).filter((b) => b.data.symbol === 'usd' && b.data.schema === 'available').reduce((n, b) => n + b.data.amount, 0)
}
async function mirror(name: string, clearingServer: string, clearingLedger: string, coreServer: string, coreLedger: string) {
  const position = await balance(clearingServer, clearingLedger, 'mint')
  let supply = 0
  for (const w of ['treasury', 'transit', 'account:1', 'account:2']) supply += await balance(coreServer, coreLedger, w)
  console.log(`      mirror ${name}: mint ${position}, bank supply ${supply} ${position === supply ? 'ok' : 'MISMATCH'}`)
}

let seq = 0
const log = (x: Record<string, unknown>) => appendFileSync(OUT, JSON.stringify({ seq: seq++, ...x }) + '\n')

// 1. Minka clears, open-ledger keeps the bank.
const key1 = await createKeyPair()
const local1 = sdkOn(LOCAL, LOCAL_CORE)
await quiet(() => makeLedger(LOCAL, LOCAL_CORE))
await bank(local1, 'local core', key1, (_, f) => quiet(f))
const bridge1 = new LedgerBridge({ handle: 'mint', keyPair: key1, upstream: { server: DIRECT, ledger: LEDGER }, downstream: { server: LOCAL, ledger: LOCAL_CORE }, wallet: 'mint', log })
await bridge1.listen(Number(process.env.BRIDGE_PORT ?? 4630))
await clearing(sdk, 'reference', key1, BRIDGE_URL, step)
for (const [name, handle, claims] of flows) {
  await step(`reference intent.create ${name}`, () => sdk.intent.init().data({ handle, claims } as any).hash().sign([{ keyPair }]).send())
  console.log(`      settled: ${await settle(DIRECT, LEDGER, handle)}`)
  await bridge1.idle()
  await step(`reference intent.read ${name}`, () => sdk.intent.read(handle))
}
await step('reference balances mint', () => sdk.wallet.getBalances('mint'))
await mirror('Minka → open-ledger', DIRECT, LEDGER, LOCAL, LOCAL_CORE)

// 2. open-ledger clears, Minka keeps the bank.
const key2 = await createKeyPair()
const remote2 = sdkOn(BASE, REMOTE_CORE)
await step('ledger.create core', () => makeLedger(BASE, REMOTE_CORE))
await bank(remote2, 'reference core', key2, step)
const bridge2 = new LedgerBridge({ handle: 'mint', keyPair: key2, upstream: { server: LOCAL, ledger: LOCAL_CLEARING }, downstream: { server: DIRECT, ledger: REMOTE_CORE }, wallet: 'mint', log })
const port2 = await bridge2.listen(0)
const local2 = sdkOn(LOCAL, LOCAL_CLEARING)
await quiet(() => makeLedger(LOCAL, LOCAL_CLEARING))
await clearing(local2, 'local', key2, `http://127.0.0.1:${port2}/v2`, (_, f) => quiet(f))
for (const [name, handle, claims] of flows) {
  await quiet(() => local2.intent.init().data({ handle, claims }).hash().sign([{ keyPair }]).send())
  console.log(`      local ${name} settled: ${await settle(LOCAL, LOCAL_CLEARING, handle)}`)
  await bridge2.idle()
}
for (const w of ['treasury', 'transit', 'account:1', 'account:2']) await step(`reference core balances ${w}`, () => remote2.wallet.getBalances(w))
await step('reference core intent.list', () => remote2.intent.list())
await mirror('open-ledger → Minka', LOCAL, LOCAL_CLEARING, DIRECT, REMOTE_CORE)

await new Promise((r) => setTimeout(r, 2000))
await bridge1.close()
await bridge2.close()
