// Operations implemented from the docs but not yet confirmed by a recording: the
// ledger record's own lifecycle (update, status, changes, access check), changes and
// access checks of every other kind, updates and status proofs of signers, circles
// and policies, and a second signature on an intent that waits for one.
//
// Ledger rules as in access4: A may do anything, B may enter and create intents,
// everyone may read.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario, ref } from './common.js'

const opts = { expiryMinutes: 60 }
const { keyPair: a, step, LEDGER, BASE } = await scenario({ ...opts, skipLedger: true } as any)
const b = await createKeyPair()
const auth = (k: any) => ({ iss: k.public, sub: `signer:${k.public}`, aud: LEDGER, exp: 3600, createHsh: false, kid: k.public, keyPair: k }) as any
const onlyA = [{ action: 'any', signer: { public: a.public } }]

await step('ledger.create', () =>
  new LedgerSdk({ server: BASE, secure: auth(a) })
    .ledger.init()
    .data({
      handle: LEDGER,
      signer: 'system',
      config: { 'intent.expiryThresholdMinutes': opts.expiryMinutes, 'access.strategy': 'record-based' },
      access: [
        { action: 'any', record: 'any', signer: { public: a.public } },
        { action: 'access', signer: { public: b.public } },
        { action: 'create', record: 'intent' },
        { action: 'read', record: 'any' },
      ],
    } as any)
    .hash()
    .sign([{ keyPair: a }])
    .send(),
)
const asA: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(a) })
const asB: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(b) })
const direct: any = new LedgerSdk({ server: process.env.DIRECT ?? BASE, ledger: LEDGER, secure: auth(a) })
const current = async (client: any, id?: string) => (await (id === undefined ? client.read() : client.read(id))).response.data

// ---- the ledger record ----------------------------------------------------------
await step('ledger.update custom', async () => asA.ledger.from(await current(asA.ledger)).data({ custom: { region: 'eu' } }).hash().sign([{ keyPair: a }]).send())
await step('ledger.status active', async () => asA.ledger.from(await current(asA.ledger)).sign([{ keyPair: a, custom: { status: 'active' } }]).send())
await step('ledger.read', () => asA.ledger.read())
await step('ledger.changes', () => asA.ledger.change.list())
await step('ledger.change 1', () => asA.ledger.change.read(1))
await step('ledger.access check read', () => asA.ledger.access.check().data({ action: 'read' }).hash().sign([{ keyPair: a }]).send())

// ---- symbol and wallets ---------------------------------------------------------
await step('symbol.create usd', () => asA.symbol.init().data({ handle: 'usd', factor: 100, access: onlyA }).hash().sign([{ keyPair: a }]).send())
await step('symbol.status active', async () => asA.symbol.from(await current(asA.symbol, 'usd')).sign([{ keyPair: a, custom: { status: 'active' } }]).send())
await step('symbol.changes', () => asA.symbol.with('usd').change.list())
await step('symbol.change 2', () => asA.symbol.with('usd').change.read(2))
await step('symbol.access check issue', () => asA.symbol.with('usd').access.check().data({ action: 'issue' }).hash().sign([{ keyPair: a }]).send())
for (const h of ['alice', 'bobw'])
  await step(`wallet.create ${h}`, () => asA.wallet.init().data({ handle: h, access: onlyA }).hash().sign([{ keyPair: a }]).send())

// ---- intents ----------------------------------------------------------------------
async function poll(handle: string, done: (i: any) => boolean, seconds: number) {
  for (let n = 0; n < seconds * 2; n++) {
    try {
      const i: any = (await direct.intent.read(handle)).response.data
      if (done(i)) return i.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
const final = (i: any) => ['completed', 'rejected'].includes(i.meta.status)
const resolved = (i: any) => final(i) || i.meta.proofs.some((p: any) => p.custom?.status === 'resolved')

await step('intent.create issue by A', () =>
  asA.intent.init().data({ handle: 'i-a', claims: [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 1000 }] }).hash().sign([{ keyPair: a }]).send(),
)
console.log(`      settled: ${await poll('i-a', final, 30)}`)
await step('intent.changes i-a', () => asA.intent.with('i-a').change.list())
await step('intent.change 1', () => asA.intent.with('i-a').change.read(1))
await step('intent.access check read', () => asA.intent.with('i-a').access.check().data({ action: 'read' }).hash().sign([{ keyPair: a }]).send())

// B spends alice without `spend`: the intent waits. A signs it as well.
await step('intent.create spend by B', () =>
  asB.intent.init().data({ handle: 'i-b', claims: [{ action: 'transfer', source: ref('alice'), target: ref('bobw'), symbol: ref('usd'), amount: 10 }] }).hash().sign([{ keyPair: b }]).send(),
)
console.log(`      resolved: ${await poll('i-b', resolved, 30)}`)
await step('intent.read i-b waiting', () => asA.intent.read('i-b'))
await step('intent.sign i-b by A', async () => asA.intent.from(await current(asA.intent, 'i-b')).sign([{ keyPair: a }]).send())
// The reference left it pending for 60 s; waiting 10 s is enough to see it not move.
console.log(`      settled: ${await poll('i-b', final, 10)}`)
await step('intent.read i-b signed', () => asA.intent.read('i-b'))
await step('balances bobw', () => asA.wallet.getBalances('bobw'))

// ---- signers ------------------------------------------------------------------------
const other = await createKeyPair()
await step('signer.create ops', () => asA.signer.init().data({ handle: 'ops', public: other.public, format: 'ed25519-raw' }).hash().sign([{ keyPair: a }]).send())
await step('signer.update ops', async () => asA.signer.from(await current(asA.signer, 'ops')).data({ custom: { team: 'ops' } }).hash().sign([{ keyPair: a }]).send())
await step('signer.status inactive', async () => asA.signer.from(await current(asA.signer, 'ops')).sign([{ keyPair: a, custom: { status: 'inactive' } }]).send())
await step('signer.changes', () => asA.signer.with('ops').change.list())
await step('signer.access check update', () => asA.signer.with('ops').access.check().data({ action: 'update' }).hash().sign([{ keyPair: a }]).send())

// ---- circles ------------------------------------------------------------------------
await step('circle.create team', () => asA.circle.init().data({ handle: 'team', access: onlyA }).hash().sign([{ keyPair: a }]).send())
await step('circle.read', () => asA.circle.read('team'))
await step('circle.list', () => asA.circle.list())
await step('circle.update', async () => asA.circle.from(await current(asA.circle, 'team')).data({ custom: { n: 1 } }).hash().sign([{ keyPair: a }]).send())
await step('circle.status active', async () => asA.circle.from(await current(asA.circle, 'team')).sign([{ keyPair: a, custom: { status: 'active' } }]).send())
await step('circle.changes', () => asA.circle.with('team').change.list())
await step('circle.access check read', () => asA.circle.with('team').access.check().data({ action: 'read' }).hash().sign([{ keyPair: a }]).send())
await step('circle.signer add ops', () => asA.circle.with('team').signer.init().data({ circle: 'team', signer: 'ops' }).hash().sign([{ keyPair: a }]).send())
await step('circle.signer list', () => asA.circle.with('team').signer.list())

// ---- policies -----------------------------------------------------------------------
const values = [{ status: 'active', quorum: [{ public: a.public }] }]
await step('policy.create', () => asA.policy.init().data({ handle: 'p', schema: 'status', record: 'symbol', values, access: onlyA }).hash().sign([{ keyPair: a }]).send())
await step('policy.read', () => asA.policy.read('p'))
await step('policy.list', () => asA.policy.list())
await step('policy.update', async () => asA.policy.from(await current(asA.policy, 'p')).data({ custom: { n: 1 } }).hash().sign([{ keyPair: a }]).send())
await step('policy.changes', () => asA.policy.with('p').change.list())
await step('policy.access check read', () => asA.policy.with('p').access.check().data({ action: 'read' }).hash().sign([{ keyPair: a }]).send())
