// DTC policies (`schema: dtc`, record `intent`; in the spec since 2.46, no prose in the
// docs): an intent a policy matches is walked through the policy's steps instead of the
// fixed chain. Each flow below is one intent, picked by its `custom.flow`, so a policy
// that leaves an intent stuck does no more work (it waits for its expiry).
//
//   basic   core.prepare, prepared, core.commit, committed, completed; before and after
//           the policy is signed active
//   short   core.commit alone
//   rel     a policy filter relative to data (`custom.flow`), not `data.custom.flow`
//   prio    three policies match: priority 5, priority 1, none
//   tie     two policies of one priority match
//   stepf   a step whose filter does not match the intent
//   bridge  a bridged credit: dtc.prepare both sides, notify `confirm`, dtc.commit
//   fail    the same, with the bridge failing its prepare
//   par     flow.parallel of the two prepares
// and policies the schema refuses.
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
  out: process.env.BRIDGE_OUT ?? '.rec/dtc.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  handle: 'bank',
  keyPair: bankKey,
  decide: (entry) => (entry?.intent?.data?.handle === 'i-fail' ? { status: 'failed', reason: 'bridge.unexpected-error', detail: 'Account acc is closed' } : { status: 'prepared' }),
})

await step('bridge.create bank', () =>
  (sdk as any).bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: BRIDGE_URL }, secure: [], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create bank', () =>
  (sdk as any).signer.init().data({ handle: 'bank', public: bankKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send(),
)
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'bob' })
await create('wallet', { handle: 'acc', bridge: 'bank' })
const usd = ref('usd')
await intent('fund alice', 'i-fund', [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 1000 }])

const policy = (data: Record<string, unknown>) =>
  step(`policy.create ${data.handle}`, () => (sdk as any).policy.init().data({ schema: 'dtc', record: 'intent', access: mine, ...data }).hash().sign([{ keyPair }]).send())
const activate = (handle: string) =>
  step(`policy.activate ${handle}`, async () => {
    const r: any = await (sdk as any).policy.read(handle)
    return (sdk as any).policy.from(r.response.data).sign([{ keyPair, custom: { status: 'active' } }]).send()
  })
const flow = (name: string) => ({ 'data.custom.flow': name })
const src = { $resolve: 'source' }
const tgt = { $resolve: 'target' }

const direct: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
// Waits for a final status, at most 20 s: a flow may leave the intent where it is.
async function until(handle: string) {
  let last = 'none'
  for (let i = 0; i < 40; i++) {
    try {
      last = (await direct.intent.read(handle)).response.data.meta.status
      if (['completed', 'rejected'].includes(last)) break
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return last
}
async function move(handle: string, name: string, target: string, amount: number, custom: Record<string, unknown> = {}) {
  await step(`intent.create ${handle}`, () =>
    sdk.intent.init().data({ handle, claims: [{ action: 'transfer', source: ref('alice'), target: ref(target), symbol: usd, amount }], custom: { flow: name, ...custom }, access: mine } as any).hash().sign([{ keyPair }]).send(),
  )
  console.log(`      reached: ${await until(handle)}`)
  // A moment for anything the reference still does after the status read.
  await new Promise((r) => setTimeout(r, 2000))
  await step(`intent.read ${handle}`, () => sdk.intent.read(handle))
  await step(`balances alice after ${handle}`, () => sdk.wallet.getBalances('alice'))
  await step(`balances ${target} after ${handle}`, () => sdk.wallet.getBalances(target))
}

// basic: the fixed chain written out.
await policy({
  handle: 'dtc-basic',
  filter: flow('basic'),
  values: [
    { invoke: 'core.prepare', values: [{ schema: 'debit', wallet: src }] },
    { invoke: 'dtc.setStatus', status: 'prepared' },
    { invoke: 'core.commit', values: [{ schema: 'debit', wallet: src }, { schema: 'credit', wallet: tgt }] },
    { invoke: 'dtc.setStatus', status: 'committed' },
    { invoke: 'dtc.setStatus', status: 'completed' },
  ],
})
await step('policy.read dtc-basic', () => (sdk as any).policy.read('dtc-basic'))
await move('i-basic-1', 'basic', 'bob', 10)
await activate('dtc-basic')
await move('i-basic-2', 'basic', 'bob', 11)

await policy({ handle: 'dtc-short', filter: flow('short'), values: [{ invoke: 'core.commit', values: [{ schema: 'debit', wallet: src }, { schema: 'credit', wallet: tgt }] }] })
await activate('dtc-short')
await move('i-short', 'short', 'bob', 12)

await policy({
  handle: 'dtc-rel',
  filter: { 'custom.flow': 'rel' },
  values: [
    { invoke: 'core.commit', values: [{ schema: 'debit', wallet: src }, { schema: 'credit', wallet: tgt }] },
    { invoke: 'dtc.setStatus', status: 'committed' },
  ],
})
await activate('dtc-rel')
await move('i-rel', 'rel', 'bob', 13)

// prio: each policy ends the intent in another status.
await policy({ handle: 'dtc-p5', filter: flow('prio'), config: { priority: 5 }, values: [{ invoke: 'core.commit', values: [{ schema: 'debit', wallet: src }, { schema: 'credit', wallet: tgt }] }, { invoke: 'dtc.setStatus', status: 'completed' }] })
await policy({ handle: 'dtc-p1', filter: flow('prio'), config: { priority: 1 }, values: [{ invoke: 'core.prepare', values: [{ schema: 'debit', wallet: src }] }, { invoke: 'dtc.setStatus', status: 'prepared' }] })
await policy({ handle: 'dtc-pnone', filter: flow('prio'), values: [{ invoke: 'dtc.setStatus', status: 'committed' }] })
for (const h of ['dtc-p5', 'dtc-p1', 'dtc-pnone']) await activate(h)
await move('i-prio', 'prio', 'bob', 14)

// tie: two policies of the same priority match (the SDK's types: an error).
await policy({ handle: 'dtc-tie-a', filter: flow('tie'), config: { priority: 2 }, values: [{ invoke: 'dtc.setStatus', status: 'completed' }] })
await policy({ handle: 'dtc-tie-b', filter: flow('tie'), config: { priority: 2 }, values: [{ invoke: 'dtc.setStatus', status: 'completed' }] })
for (const h of ['dtc-tie-a', 'dtc-tie-b']) await activate(h)
await move('i-tie', 'tie', 'bob', 19)

await policy({
  handle: 'dtc-stepf',
  filter: flow('stepf'),
  values: [
    { invoke: 'core.commit', filter: { 'data.custom.skip': 'no' }, values: [{ schema: 'debit', wallet: src }, { schema: 'credit', wallet: tgt }] },
    { invoke: 'dtc.setStatus', status: 'completed' },
  ],
})
await activate('dtc-stepf')
await move('i-stepf', 'stepf', 'bob', 15, { skip: 'yes' })

const bridged = [
  { invoke: 'dtc.prepare', schema: 'debit', wallet: src },
  { invoke: 'dtc.prepare', schema: 'credit', bridge: tgt },
  { invoke: 'dtc.notify', schema: 'credit', action: 'confirm' },
  { invoke: 'dtc.setStatus', status: 'prepared' },
  { invoke: 'core.commit', values: [{ schema: 'debit', wallet: src }] },
  { invoke: 'dtc.commit', schema: 'credit' },
  { invoke: 'dtc.setStatus', status: 'committed' },
  { invoke: 'dtc.setStatus', status: 'completed' },
]
await policy({ handle: 'dtc-bridge', filter: { 'data.custom.flow': { $in: ['bridge', 'fail'] } }, values: bridged })
await activate('dtc-bridge')
await move('i-bridge', 'bridge', 'acc', 16)
await move('i-fail', 'fail', 'acc', 17)

await policy({
  handle: 'dtc-par',
  filter: flow('par'),
  values: [
    { invoke: 'flow.parallel', values: [{ invoke: 'dtc.prepare', schema: 'debit', wallet: src }, { invoke: 'dtc.prepare', schema: 'credit', bridge: tgt }] },
    { invoke: 'core.commit', values: [{ schema: 'debit', wallet: src }] },
    { invoke: 'dtc.commit', schema: 'credit' },
    { invoke: 'dtc.setStatus', status: 'completed' },
  ],
})
await activate('dtc-par')
await move('i-par', 'par', 'acc', 18)

// Refused by the schema (or not).
await policy({ handle: 'bad-notify', filter: flow('x'), values: [{ invoke: 'dtc.notify', schema: 'credit', action: 'commit' }] })
await policy({ handle: 'bad-both', filter: flow('x'), values: [{ invoke: 'dtc.prepare', schema: 'debit', wallet: src, bridge: src }] })
await policy({ handle: 'bad-record', record: 'wallet', filter: flow('x'), values: [{ invoke: 'dtc.setStatus', status: 'completed' }] })
await policy({ handle: 'bad-empty', filter: flow('x'), values: [] })
await policy({ handle: 'bad-invoke', filter: flow('x'), values: [{ invoke: 'dtc.foo' }] })
await policy({ handle: 'bad-status', filter: flow('x'), values: [{ invoke: 'dtc.setStatus' }] })
await policy({ handle: 'bad-priority', filter: flow('x'), config: { priority: -1 }, values: [{ invoke: 'dtc.setStatus', status: 'completed' }] })
await policy({ handle: 'ok-object', filter: flow('x'), values: [{ invoke: { method: 'dtc.setStatus' }, status: 'completed', filter: { 'data.custom.y': 1 } }, { invoke: 'core.commit', config: { suspendTimeoutMs: 60000 }, values: [{ schema: 'credit', wallet: 'bob' }] }] })
await step('policy.list', () => (sdk as any).policy.list())

await new Promise((r) => setTimeout(r, 2000))
await bridge.close()
