// Follow-up to `policies`. There, in a policy-based ledger, an active
// `{update, signer: {$circle: bank}}` did not let B update a wallet and an active
// `{read, bearer: {$signer: {$circle: bank}}}` did not let B read one, while A's
// active admin policy worked. Hypothesis: the ledger's own rules no longer count, so
// nobody but A has `access` on the ledger, and the gate applies to reads as well.
//
// Also: does a read need `access` in a record-based ledger (C has none), and does
// `extend` pull values from a policy that is not active?
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const opts = { expiryMinutes: 60 }
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
        { action: 'access', bearer: { $signer: { public: b.public } } },
      ],
    } as any)
    .hash()
    .sign([{ keyPair: a }])
    .send(),
)
const asA: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(a) })
const asB: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(b) })
const asC: any = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(c) })
const current = async (client: any, id?: string) => (await (id === undefined ? client.read() : client.read(id))).response.data
const policy = (data: Record<string, unknown>) =>
  step(`policy.create ${data.handle}`, () => asA.policy.init().data({ schema: 'access', access: onlyA, ...data }).hash().sign([{ keyPair: a }]).send())
const status = (handle: string, value: string) =>
  step(`policy.status ${handle} ${value}`, async () => asA.policy.from(await current(asA.policy, handle)).sign([{ keyPair: a, custom: { status: value } }]).send())
const updateW = (who: any, key: any, name: string) =>
  step(`wallet.update w by ${name}`, async () => who.wallet.from(await current(asA.wallet, 'w')).data({ custom: { by: name } }).hash().sign([{ keyPair: key }]).send())

await step('signer.create b', () => asA.signer.init().data({ handle: 'b', public: b.public, format: 'ed25519-raw', access: onlyA }).hash().sign([{ keyPair: a }]).send())
await step('circle.create bank', () => asA.circle.init().data({ handle: 'bank', access: onlyA }).hash().sign([{ keyPair: a }]).send())
await step('circle.signer add b', () => asA.circle.with('bank').signer.init().data({ circle: 'bank', signer: 'b' }).hash().sign([{ keyPair: a }]).send())

// Record-based: C has no `access` on the ledger; the wallet lets C read it.
await step('wallet.create w', () =>
  asA.wallet.init().data({ handle: 'w', access: [...onlyA, { action: 'read', bearer: { $signer: { public: c.public } } }] }).hash().sign([{ keyPair: a }]).send(),
)
await step('wallet.read w as C (record rule, no access)', () => asC.wallet.read('w'))

await policy({ handle: 'admin', record: 'any', values: [{ action: 'any', signer: { public: a.public } }, { action: 'any', bearer: { $signer: { public: a.public } } }] })
await status('admin', 'active')
await policy({ handle: 'base', record: 'wallet', values: [{ action: 'read', bearer: { $signer: { public: c.public } } }] })
await policy({ handle: 'derived', extend: 'base', record: 'wallet', values: [{ action: 'update', signer: { public: c.public } }] })
await status('derived', 'active')
await policy({ handle: 'bank-wallets', record: 'wallet', values: [{ action: 'read', bearer: { $signer: { $circle: 'bank' } } }, { action: 'update', signer: { $circle: 'bank' } }] })
await status('bank-wallets', 'active')

await step('ledger.update policy-based', async () => {
  const cur = await current(asA.ledger)
  return asA.ledger.from(cur).data({ config: { ...cur.data.config, 'access.strategy': 'policy-based' } }).hash().sign([{ keyPair: a }]).send()
})

// Nobody but A may enter yet.
await step('wallet.read w as B (no access policy)', () => asB.wallet.read('w'))
await updateW(asB, b, 'B (no access policy)')
await step('wallet.read w as C (record rule ignored?)', () => asC.wallet.read('w'))

await policy({ handle: 'enter', record: 'ledger', values: [{ action: 'access', signer: { $circle: 'bank' } }, { action: 'access', bearer: { $signer: { $circle: 'bank' } } }] })
await status('enter', 'active')
await step('wallet.read w as B (enter active)', () => asB.wallet.read('w'))
await updateW(asB, b, 'B (enter active)')
await step('wallet.access check update w as B', () => asB.wallet.with('w').access.check().data({ action: 'update' }).hash().sign([{ keyPair: b }]).send())

// C may enter too; `derived` is active, the `base` it extends is not.
await policy({ handle: 'enter-c', record: 'any', values: [{ action: 'access', signer: { public: c.public } }, { action: 'access', bearer: { $signer: { public: c.public } } }] })
await status('enter-c', 'active')
await step('wallet.read w as C (base via derived)', () => asC.wallet.read('w'))
await updateW(asC, c, 'C (derived)')
await step('ledger.read as C', () => asC.ledger.read())
