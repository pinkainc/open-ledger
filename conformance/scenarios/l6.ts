// L6: several participants in one intent. Two bridges on one port (conformance/bridge.ts):
// `bank1` groups nothing; `bank2` groups debits by address and credits by wallet
// (about-bridges, "Claim grouping"). alice is a wallet of the ledger itself; a1 and a1b
// belong to bank1, b2 and b2b to bank2. Questions this records:
//
// - debit and credit on different bridges, and on the same bridge, in one intent
// - the order of prepare calls across bridges and claims; of aborts after a failure
// - whether a failed debit prepare still sends the credit prepare
// - what a grouped call looks like (`claims.groupBy`)
// - a bridge that accepts a prepare and never reports (does the intent expire?)
// - a bridge that never reports `committed` (commit cannot fail — what then?)
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges, type Decision } from '../bridge.js'
import { ref, scenario } from './common.js'

// A one-minute expiry, so the silent prepare below is aborted within the run.
const { sdk, keyPair, step, create, LEDGER, secure } = await scenario({ expiryMinutes: 1 })
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const key1 = await createKeyPair()
const key2 = await createKeyPair()

const intentOf = (entry: any) => entry?.intent?.data?.handle as string
const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/l6.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [
    {
      handle: 'bank1',
      prefix: '/bank1',
      keyPair: key1,
      decide: (entry): Decision => {
        if (intentOf(entry) === 'i-fail-debit') return { status: 'failed', reason: 'bridge.unexpected-error', detail: 'Account a1 is frozen' }
        return { status: 'prepared' }
      },
      report: (_entry, action, intent) => !(action === 'commit' && intent?.data?.handle === 'i-no-commit'),
    },
    {
      handle: 'bank2',
      prefix: '/bank2',
      keyPair: key2,
      decide: (entry): Decision => {
        if (intentOf(entry) === 'i-fail-credit') return { status: 'failed', reason: 'bridge.unexpected-error', detail: 'Account b2 is closed' }
        if (intentOf(entry) === 'i-silent') return { silent: true }
        return { status: 'prepared' }
      },
    },
  ],
})

const mineOf = (k: any) => [{ action: 'any', signer: { public: k.public } }]
for (const [handle, k, config] of [
  ['bank1', key1, {}],
  ['bank2', key2, { 'debits.claims.groupBy': 'address', 'credits.claims.groupBy': 'wallet' }],
] as const) {
  await step(`bridge.create ${handle}`, () =>
    (sdk as any).bridge
      .init()
      .data({ handle, schema: 'rest', config: { server: `${BASE_URL}/${handle}/v2`, ...config }, secure: [], access: mineOf(keyPair) })
      .hash()
      .sign([{ keyPair }])
      .send(),
  )
  await step(`signer.create ${handle}`, () =>
    (sdk as any).signer.init().data({ handle, public: k.public, format: 'ed25519-raw', access: mineOf(keyPair) }).hash().sign([{ keyPair }]).send(),
  )
}
await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'a1', bridge: 'bank1' })
await create('wallet', { handle: 'a1b', bridge: 'bank1' })
await create('wallet', { handle: 'b2', bridge: 'bank2' })
await create('wallet', { handle: 'b2b', bridge: 'bank2' })

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
async function settle(handle: string, seconds = 60) {
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

// Funding: issues call no bridge (l5).
await move('fund', 'i-fund', [
  { action: 'issue', target: ref('alice'), symbol: usd, amount: 1000 },
  { action: 'issue', target: ref('a1'), symbol: usd, amount: 500 },
  { action: 'issue', target: ref('b2'), symbol: usd, amount: 500 },
])
await move('bank1 to bank2', 'i-cross', [t('a1', 'b2', 20)])
await move('within bank1', 'i-same', [t('a1', 'a1b', 10)])
await move('three claims, two bridges', 'i-multi', [t('alice', 'a1', 5), t('alice', 'b2', 6), t('a1', 'alice', 7)])
await move('grouped on bank2', 'i-group', [t('alice', 'b2', 3), t('alice', 'b2', 4), t('b2', 'alice', 2), t('b2', 'b2b', 1)])
await move('bank2 fails the credit', 'i-fail-credit', [t('a1', 'alice', 4), t('alice', 'b2', 9)])
await move('bank1 fails the debit', 'i-fail-debit', [t('a1', 'b2', 8)])

// Two that never finish on their own: bank1 never confirms a commit, bank2 never
// answers a prepare. The second should expire (one-minute threshold).
await send('bank1 never confirms the commit', 'i-no-commit', [t('a1', 'alice', 1)])
await send('bank2 never answers the prepare', 'i-silent', [t('alice', 'b2', 2)])
console.log(`      i-silent settled: ${await settle('i-silent', 240)}`)
await step('intent.read i-silent', () => sdk.intent.read('i-silent'))
await step('intent.read i-no-commit', () => sdk.intent.read('i-no-commit'))

for (const w of ['alice', 'a1', 'a1b', 'b2', 'b2b']) await step(`balances ${w}`, () => sdk.wallet.getBalances(w))

// Late proofs from the bridges land in their log; give them a moment before closing.
await new Promise((r) => setTimeout(r, 3000))
await bridges.close()
