// Follow-up to `policies3`, which found that a policy in a domain applies to that
// domain's records only, that `filter` keys are relative to `data` and checked against a
// list per record kind, that `action` must be one string, and that `invoke:
// intent.canReadAnyClaimWallet` works — but lists left out every record K could read
// through a filtered or invoked rule. Here:
// - the allowed filter keys of wallets and intents (an invalid key lists them);
// - a filter with an operator (`handle: {$in: …}`);
// - `intent.canSpendEveryClaimWallet` with K able to spend some wallets;
// - `wallet.canSpendAllChangedRouteTargets` on create;
// - whether a list shows what a plain (unfiltered) read rule grants, and what a
//   filtered one grants.
// A is the operator (an active admin policy); K enters through an active policy.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { keyPair: a, step, LEDGER, BASE } = await scenario({ skipLedger: true })
const k = await createKeyPair()
const auth = (key: any) => ({ iss: key.public, sub: `signer:${key.public}`, aud: LEDGER, exp: 3600, createHsh: false, kid: key.public, keyPair: key }) as any
const onlyA = [{ action: 'any', signer: { public: a.public } }]
const asA: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(a) })
const asK: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(k) })
const current = async (client: any, id?: string) => (await (id === undefined ? client.read() : client.read(id))).response.data

await step('ledger.create', () =>
  new LedgerSdk({ server: BASE, secure: auth(a) })
    .ledger.init()
    .data({
      handle: LEDGER,
      signer: 'system',
      config: { 'intent.expiryThresholdMinutes': 60, 'access.strategy': 'record-based' },
      access: [{ action: 'any', record: 'any', signer: { public: a.public } }, { action: 'read', record: 'any', bearer: { $signer: { public: a.public } } }],
    } as any)
    .hash()
    .sign([{ keyPair: a }])
    .send(),
)
const policy = (data: Record<string, unknown>) =>
  step(`policy.create ${data.handle}`, async () => {
    await asA.policy.init().data({ schema: 'access', access: onlyA, ...data }).hash().sign([{ keyPair: a }]).send()
    return asA.policy.from(await current(asA.policy, data.handle as string)).sign([{ keyPair: a, custom: { status: 'active' } }]).send()
  })
const mk = (who: 'A' | 'K', client: string, data: Record<string, unknown>) =>
  step(`${who} ${client}.create ${data.handle}`, () => (who === 'A' ? asA : asK)[client].init().data(data).hash().sign([{ keyPair: who === 'A' ? a : k }]).send())
const transfer = (who: 'A' | 'K', handle: string, source: string, target: string) =>
  step(`${who} intent.create ${handle} ${source} → ${target}`, () =>
    (who === 'A' ? asA : asK).intent
      .init()
      .data({ handle, claims: [{ action: 'transfer', source: { handle: source }, target: { handle: target }, symbol: { handle: 'usd' }, amount: 1 }] })
      .hash()
      .sign([{ keyPair: who === 'A' ? a : k }])
      .send(),
  )

await policy({ handle: 'admin', record: 'any', values: [{ action: 'any', signer: { public: a.public } }, { action: 'any', bearer: { $signer: { public: a.public } } }] })
await policy({ handle: 'enter', record: 'ledger', values: [{ action: 'access', signer: { public: k.public } }, { action: 'access', bearer: { $signer: { public: k.public } } }] })
await step('ledger.update policy-based', async () => {
  const cur = await current(asA.ledger)
  return asA.ledger.from(cur).data({ config: { ...cur.data.config, 'access.strategy': 'policy-based' } }).hash().sign([{ keyPair: a }]).send()
})


await policy({ handle: 'bad-wallet-filter', record: 'wallet', values: [{ action: 'read', bearer: { $signer: { public: k.public } }, filter: { 'data.handle': 'x' } }] })
await policy({ handle: 'bad-intent-filter', record: 'intent', values: [{ action: 'read', bearer: { $signer: { public: k.public } }, filter: { 'data.handle': 'x' } }] })

for (const h of ['b1', 'b2', 'b3']) await mk('A', 'wallet', { handle: h })
await mk('A', 'symbol', { handle: 'usd', factor: 100 })
await mk('A', 'symbol', { handle: 'eur', factor: 100 })
await policy({
  handle: 'k-wallets',
  record: 'wallet',
  values: [
    { action: 'spend', signer: { public: k.public }, filter: { handle: { $in: ['b1', 'b2'] } } },
    { action: 'read', bearer: { $signer: { public: k.public } }, filter: { handle: { $in: ['b1', 'b2'] } } },
  ],
})
await step('K wallet.read b1', () => asK.wallet.read('b1'))
await step('K wallet.read b3', () => asK.wallet.read('b3'))
await step('K wallet.list (filtered read)', () => asK.wallet.list())

// Lists: a filtered read on symbols, then a plain one.
await policy({ handle: 'usd-reader', record: 'symbol', values: [{ action: 'read', bearer: { $signer: { public: k.public } }, filter: { handle: 'usd' } }] })
await step('K symbol.list (filtered read)', () => asK.symbol.list())
await policy({ handle: 'sym-reader', record: 'symbol', values: [{ action: 'read', bearer: { $signer: { public: k.public } } }] })
await step('K symbol.list (plain read)', () => asK.symbol.list())

// intent.canSpendEveryClaimWallet: K may spend b1 and b2, not b3.
await policy({ handle: 'k-intents', record: 'intent', values: [{ action: 'create', signer: { public: k.public }, invoke: 'intent.canSpendEveryClaimWallet' }] })
await step('A intent.create seed', () =>
  asA.intent.init().data({ handle: 'seed', claims: ['b1', 'b3'].map((h) => ({ action: 'issue', target: { handle: h }, symbol: { handle: 'usd' }, amount: 10 })) }).hash().sign([{ keyPair: a }]).send(),
)
await new Promise((r) => setTimeout(r, 3000))
await transfer('K', 'k-12', 'b1', 'b2')
await transfer('K', 'k-13', 'b1', 'b3')
await new Promise((r) => setTimeout(r, 3000))
await step('intent.read k-12', () => asA.intent.read('k-12'))

// wallet.canSpendAllChangedRouteTargets on create.
await policy({ handle: 'k-create', record: 'wallet', values: [{ action: 'create', signer: { public: k.public }, invoke: 'wallet.canSpendAllChangedRouteTargets' }] })
await mk('K', 'wallet', { handle: 'r-none' })
await mk('K', 'wallet', { handle: 'r-b2', routes: [{ action: 'forward', target: 'b2' }] })
await mk('K', 'wallet', { handle: 'r-b3', routes: [{ action: 'forward', target: 'b3' }] })
