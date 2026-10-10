// Two questions access4 left open about claim permissions:
//   - does `destroy` need `spend` on the source besides `destroy` on the symbol?
//   - are claim permissions checked before limits? An intent that lacks a permission
//     and would also overdraw: pending until expiry (permissions first) or rejected at
//     once with core.limit-exceeded (limits first)?
// Ledger rules as in access4: A may do anything, B may enter, create intents, read.
// B has `destroy` on the symbol and `spend` on its own wallet `bw` only.
// Bounded: five intents; the two without permission expire after a minute.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario, ref } from './common.js'

const opts = { expiryMinutes: 1, settleSeconds: 240 }
const { keyPair: a, step, LEDGER, BASE } = await scenario({ ...opts, skipLedger: true } as any)
const b = await createKeyPair()
const auth = (k: any) => ({ iss: k.public, sub: `signer:${k.public}`, aud: LEDGER, exp: 3600, createHsh: false, kid: k.public, keyPair: k }) as any
const onlyA = { action: 'any', signer: { public: a.public } }

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
const asA = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(a) })
const asB = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(b) })
const direct = new LedgerSdk({ server: process.env.DIRECT ?? BASE, ledger: LEDGER, secure: auth(a) })

await step('symbol.create usd', () =>
  asA.symbol.init().data({ handle: 'usd', factor: 100, access: [onlyA, { action: 'destroy', signer: { public: b.public } }] } as any).hash().sign([{ keyPair: a }]).send(),
)
await step('wallet.create alice', () => asA.wallet.init().data({ handle: 'alice', access: [onlyA] } as any).hash().sign([{ keyPair: a }]).send())
await step('wallet.create bw', () =>
  asA.wallet.init().data({ handle: 'bw', access: [onlyA, { action: 'spend', signer: { public: b.public } }] } as any).hash().sign([{ keyPair: a }]).send(),
)

async function settle(handle: string) {
  for (let i = 0; i < opts.settleSeconds * 2; i++) {
    const r: any = await direct.intent.read(handle).catch(() => undefined)
    if (['completed', 'rejected'].includes(r?.meta?.status)) return r.meta.status
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
const usd = ref('usd')
const send = (name: string, handle: string, claims: unknown[], who: LedgerSdk, k: any) =>
  step(`intent.create ${name}`, () => who.intent.init().data({ handle, claims } as any).hash().sign([{ keyPair: k }]).send())

await send('seed by A', 'i-seed', [
  { action: 'issue', target: ref('alice'), symbol: usd, amount: 1000 },
  { action: 'issue', target: ref('bw'), symbol: usd, amount: 1000 },
], asA, a)
console.log(`      settled: ${await settle('i-seed')}`)

await send('destroy from bw by B', 'i-destroy-own', [{ action: 'destroy', source: ref('bw'), symbol: usd, amount: 10 }], asB, b)
await send('destroy from alice by B', 'i-destroy-alice', [{ action: 'destroy', source: ref('alice'), symbol: usd, amount: 10 }], asB, b)
await send('overdraw alice by B', 'i-overdraw', [{ action: 'transfer', source: ref('alice'), target: ref('bw'), symbol: usd, amount: 5000 }], asB, b)
await send('overdraw bw by B', 'i-overdraw-own', [{ action: 'transfer', source: ref('bw'), target: ref('alice'), symbol: usd, amount: 5000 }], asB, b)

for (const h of ['i-destroy-own', 'i-destroy-alice', 'i-overdraw', 'i-overdraw-own']) {
  console.log(`      ${h}: ${await settle(h)}`)
  await step(`intent.read ${h}`, () => asA.intent.read(h))
}
await step('balances alice', () => asA.wallet.getBalances('alice'))
await step('balances bw', () => asA.wallet.getBalances('bw'))
