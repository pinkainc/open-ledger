// Access policies (docs: securing-the-ledger/about-policies, policy-based-access,
// migrate-access-strategy, about-authorization).
//
// Part 1, record-based: rules `{policy: handle}` on records name `schema: access`
// policies. Does a reference expand to the policy's values, does the policy's
// `record` limit where it applies, does `extend` inherit, does the policy's status
// matter, and what does an access check list?
// Part 2, the ledger migrated to `policy-based`: are record rules ignored, do only
// active policies count, is the migration one-way, are owners still stored?
//
// A may do anything; B is in circle `bank`; C is a bare key that may enter.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario, ref } from './common.js'

const opts = { expiryMinutes: 60, settleSeconds: 60 }
const { keyPair: a, step, LEDGER, BASE } = await scenario({ ...opts, skipLedger: true } as any)
const b = await createKeyPair()
const c = await createKeyPair()
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
        { action: 'read', record: 'any', bearer: { $signer: { public: a.public } } },
        { action: 'access', signer: { public: b.public } },
        { action: 'access', signer: { public: c.public } },
        { action: 'read' },
      ],
    } as any)
    .hash()
    .sign([{ keyPair: a }])
    .send(),
)
const asA: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(a) })
const asB: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(b) })
const asC: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(c) })
const direct: any = new LedgerSdk({ server: process.env.DIRECT ?? BASE, ledger: LEDGER, secure: auth(a) })
const current = async (client: any, id?: string) => (await (id === undefined ? client.read() : client.read(id))).response.data
const policy = (data: Record<string, unknown>) =>
  step(`policy.create ${data.handle}`, () => asA.policy.init().data({ schema: 'access', access: onlyA, ...data }).hash().sign([{ keyPair: a }]).send())
const status = (handle: string, value: string) =>
  step(`policy.status ${handle} ${value}`, async () => asA.policy.from(await current(asA.policy, handle)).sign([{ keyPair: a, custom: { status: value } }]).send())
const update = (who: any, key: any, client: 'wallet' | 'symbol', handle: string, name: string) =>
  step(`${client}.update ${handle} by ${name}`, async () =>
    who[client].from(await current(asA[client], handle)).data({ custom: { by: name } }).hash().sign([{ keyPair: key }]).send(),
  )

await step('signer.create b', () => asA.signer.init().data({ handle: 'b', public: b.public, format: 'ed25519-raw', access: onlyA }).hash().sign([{ keyPair: a }]).send())
await step('circle.create bank', () => asA.circle.init().data({ handle: 'bank', access: onlyA }).hash().sign([{ keyPair: a }]).send())
await step('circle.signer add b', () => asA.circle.with('bank').signer.init().data({ circle: 'bank', signer: 'b' }).hash().sign([{ keyPair: a }]).send())

// ---- part 1: record-based ------------------------------------------------------------
await policy({ handle: 'reader', record: 'any', values: [{ action: 'read', bearer: { $signer: { $circle: 'bank' } } }] })
await policy({ handle: 'wallet-reader', extend: 'reader', record: 'wallet', values: [{ action: 'read', bearer: { $signer: { public: c.public } } }] })
await policy({ handle: 'wallet-updater', record: 'wallet', values: [{ action: 'update', signer: { $circle: 'bank' } }] })
await step('policy.read wallet-updater', () => asA.policy.read('wallet-updater'))

const wallet = (handle: string, access: unknown[]) =>
  step(`wallet.create ${handle}`, () => asA.wallet.init().data({ handle, access }).hash().sign([{ keyPair: a }]).send())
await wallet('w1', [{ policy: 'wallet-reader' }, { policy: 'wallet-updater' }, ...onlyA])
await wallet('w2', onlyA)
await wallet('w-unknown-policy', [{ policy: 'nope' }, ...onlyA])
await step('symbol.create usd', () =>
  asA.symbol.init().data({ handle: 'usd', factor: 100, access: [{ policy: 'wallet-updater' }, ...onlyA] }).hash().sign([{ keyPair: a }]).send(),
)

await step('wallet.read w1 as B (extended reader)', () => asB.wallet.read('w1'))
await step('wallet.read w1 as C (wallet-reader)', () => asC.wallet.read('w1'))
await step('wallet.read w2 as B', () => asB.wallet.read('w2'))
await update(asB, b, 'wallet', 'w1', 'B')
await update(asC, c, 'wallet', 'w1', 'C')
await update(asB, b, 'wallet', 'w2', 'B')
await update(asB, b, 'symbol', 'usd', 'B (policy for wallets)')
await step('wallet.access check update w1 as B', () => asB.wallet.with('w1').access.check().data({ action: 'update' }).hash().sign([{ keyPair: b }]).send())
await step('wallet.access check read w1 as B', () => asB.wallet.with('w1').access.check().data({ action: 'read' }).hash().sign([{ keyPair: b }]).send())

// Inactive in a record-based ledger: does a referenced policy still grant?
await status('wallet-updater', 'inactive')
await update(asB, b, 'wallet', 'w1', 'B after inactive')
await status('wallet-updater', 'active')
await update(asB, b, 'wallet', 'w1', 'B after active')
await step('policy.read wallet-updater after status', () => asA.policy.read('wallet-updater'))

// ---- part 2: policy-based --------------------------------------------------------------
// A keeps everything through an active policy before the ledger rules stop counting.
await policy({ handle: 'admin', record: 'any', values: [{ action: 'any', signer: { public: a.public } }, { action: 'any', bearer: { $signer: { public: a.public } } }] })
await status('admin', 'active')
await step('ledger.update policy-based', async () => {
  const cur = await current(asA.ledger)
  return asA.ledger.from(cur).data({ config: { ...cur.data.config, 'access.strategy': 'policy-based' } }).hash().sign([{ keyPair: a }]).send()
})
await step('ledger.read', () => asA.ledger.read())

await update(asB, b, 'wallet', 'w2', 'B (active wallet-updater, no record rule)')
await step('wallet.read w2 as B (reader created)', () => asB.wallet.read('w2'))
await step('wallet.read w2 as C (wallet-reader created)', () => asC.wallet.read('w2'))
await status('reader', 'active')
await step('wallet.read w2 as B (reader active)', () => asB.wallet.read('w2'))
await step('symbol.read usd as B (reader active)', () => asB.symbol.read('usd'))
await step('wallet.read w2 as C (extends active reader)', () => asC.wallet.read('w2'))
await status('wallet-updater', 'inactive')
await update(asB, b, 'wallet', 'w1', 'B (wallet-updater inactive)')

await wallet('w3', onlyA)
await step('wallet.read w3', () => asA.wallet.read('w3'))
await step('wallet.create by B', () => asB.wallet.init().data({ handle: 'w-b' }).hash().sign([{ keyPair: b }]).send())
await step('wallet.access check update w2 as B', () => asB.wallet.with('w2').access.check().data({ action: 'update' }).hash().sign([{ keyPair: b }]).send())
await step('wallet.access check read w2 as A', () => asA.wallet.with('w2').access.check().data({ action: 'read' }).hash().sign([{ keyPair: a }]).send())

const sent = await step('intent.create issue by A', () =>
  asA.intent.init().data({ handle: 'i-issue', claims: [{ action: 'issue', target: ref('w3'), symbol: ref('usd'), amount: 100 }], access: onlyA }).hash().sign([{ keyPair: a }]).send(),
)
if (sent) {
  for (let i = 0; i < opts.settleSeconds * 2; i++) {
    const r: any = await direct.intent.read('i-issue').catch(() => undefined)
    if (['completed', 'rejected'].includes(r?.intent?.meta?.status ?? r?.meta?.status)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  await step('intent.read i-issue', () => asA.intent.read('i-issue'))
}

await step('ledger.update back to record-based', async () => {
  const cur = await current(asA.ledger)
  return asA.ledger.from(cur).data({ config: { ...cur.data.config, 'access.strategy': 'record-based' } }).hash().sign([{ keyPair: a }]).send()
})
await status('admin', 'inactive')
await step('wallet.read w3 after admin inactive', () => asA.wallet.read('w3'))
