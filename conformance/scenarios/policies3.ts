// What `policies` and `policies2` left open (TODO, Domains `(?)`, from L4), in a
// policy-based ledger:
// - a policy in a domain (`handle@domain`, about-authorization "Domain-Specific
//   Policies"): does it apply only to records in that domain?
// - a policy value's `filter` (about-policies: `filter: {schema: fiat}`): which records
//   it covers, for reads and for lists;
// - a policy value's `invoke` (built-in checks): `intent.canSpendEveryClaimWallet` on
//   create, `intent.canReadAnyClaimWallet` on read.
// A is the operator (an active admin policy); K enters through an active policy and gets
// nothing else but what the policies below grant.
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

// Domain-specific: `pay@payments` grants K everything on wallets.
await mk('A', 'domain', { handle: 'payments' })
await mk('A', 'domain', { handle: 'other' })
await policy({ handle: 'pay@payments', record: 'wallet', values: [{ action: 'any', signer: { public: k.public } }, { action: 'read', bearer: { $signer: { public: k.public } } }] })
await step('policy.read pay@payments', () => asA.policy.read('pay@payments'))
await mk('K', 'wallet', { handle: 'k1@payments' })
await mk('K', 'wallet', { handle: 'k2@other' })
await mk('K', 'wallet', { handle: 'k3' })
await mk('A', 'wallet', { handle: 'a1@payments' })
await mk('A', 'wallet', { handle: 'a2@other' })
await step('K wallet.read a1@payments', () => asK.wallet.read('a1@payments'))
await step('K wallet.read a2@other', () => asK.wallet.read('a2@other'))
await step('K wallet.list', () => asK.wallet.list())

// filter: K may read symbols whose schema is `fiat` (the docs' example), or by handle.
await mk('A', 'schema', { handle: 'fiat', record: 'symbol', format: 'json-schema', schema: { type: 'object' } })
await mk('A', 'schema', { handle: 'crypto', record: 'symbol', format: 'json-schema', schema: { type: 'object' } })
await mk('A', 'symbol', { handle: 'usd', factor: 100, schema: 'fiat' })
await mk('A', 'symbol', { handle: 'btc', factor: 100000000, schema: 'crypto' })
await mk('A', 'symbol', { handle: 'eur', factor: 100, schema: 'fiat' })
await policy({ handle: 'fiat-readers', record: 'symbol', values: [{ action: 'read', bearer: { $signer: { public: k.public } }, filter: { schema: 'fiat' } }] })
await policy({ handle: 'btc-reader', record: 'symbol', values: [{ action: 'read', bearer: { $signer: { public: k.public } }, filter: { 'data.handle': 'btc' } }] })
for (const h of ['usd', 'btc', 'eur']) await step(`K symbol.read ${h}`, () => asK.symbol.read(h))
await step('K symbol.list', () => asK.symbol.list())

// invoke: K may create intents only when it may spend every claim wallet, and read
// those whose wallets it may read.
await mk('A', 'wallet', { handle: 'b1' })
await mk('A', 'wallet', { handle: 'b2' })
await mk('A', 'wallet', { handle: 'b3' })
await policy({ handle: 'k-wallets', record: 'wallet', values: [{ action: ['spend', 'read'], signer: { public: k.public }, filter: { 'data.handle': { $in: ['b1', 'b2'] } } }, { action: 'read', bearer: { $signer: { public: k.public } }, filter: { 'data.handle': { $in: ['b1', 'b2'] } } }] })
await policy({ handle: 'k-intents', record: 'intent', values: [{ action: 'create', signer: { public: k.public }, invoke: 'intent.canSpendEveryClaimWallet' }, { action: 'read', bearer: { $signer: { public: k.public } }, invoke: 'intent.canReadAnyClaimWallet' }] })
await step('A intent.create seed', () =>
  asA.intent.init().data({ handle: 'seed', claims: ['b1', 'b3'].map((h) => ({ action: 'issue', target: { handle: h }, symbol: { handle: 'usd' }, amount: 10 })) }).hash().sign([{ keyPair: a }]).send(),
)
await new Promise((r) => setTimeout(r, 3000))
await step('K wallet.read b1', () => asK.wallet.read('b1'))
await step('K wallet.read b3', () => asK.wallet.read('b3'))
await transfer('K', 'k-12', 'b1', 'b2')
await transfer('K', 'k-13', 'b1', 'b3')
await transfer('A', 'a-32', 'b3', 'b2')
await transfer('A', 'a-33', 'b3', 'k1@payments')
await new Promise((r) => setTimeout(r, 3000))
for (const h of ['seed', 'k-12', 'k-13', 'a-32', 'a-33']) await step(`K intent.read ${h}`, () => asK.intent.read(h))
await step('K intent.list', () => asK.intent.list())
