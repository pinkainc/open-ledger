// Follow-up to access3: claim permissions on a ledger that lets B in (`access`) and
// lets anyone create intents and read, but gives B nothing on A's wallet or symbol.
// Is a spend or issue without permission refused at POST, rejected, or left pending
// until expiry?
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario, ref } from './common.js'

const opts = { expiryMinutes: 1, settleSeconds: 200 }
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
const asA = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(a) })
const asB = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(b) })
const direct = new LedgerSdk({ server: process.env.DIRECT ?? BASE, ledger: LEDGER, secure: auth(a) })

await step('symbol.create usd by A', () => asA.symbol.init().data({ handle: 'usd', factor: 100, access: onlyA } as any).hash().sign([{ keyPair: a }]).send())
for (const h of ['alice', 'bobw'])
  await step(`wallet.create ${h} by A`, () => asA.wallet.init().data({ handle: h, access: onlyA } as any).hash().sign([{ keyPair: a }]).send())
await step('wallet.create by B', () => asB.wallet.init().data({ handle: 'mallory' } as any).hash().sign([{ keyPair: b }]).send())

async function settle(handle: string) {
  for (let i = 0; i < opts.settleSeconds * 2; i++) {
    try {
      const r: any = await direct.intent.read(handle)
      if (['completed', 'rejected'].includes(r?.meta?.status)) return r.meta.status
    } catch (e: any) {
      if (e?.reason === 'record.not-found' || e?.reason === 'auth.forbidden') return e.reason
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
async function intent(name: string, handle: string, claims: unknown[], who: LedgerSdk, keys: any[]) {
  const sent = await step(`intent.create ${name}`, () => who.intent.init().data({ handle, claims } as any).hash().sign(keys.map((k) => ({ keyPair: k }))).send())
  if (!sent) return
  console.log(`      settled: ${await settle(handle)}`)
  await step(`intent.read ${name}`, () => asA.intent.read(handle))
}
const usd = ref('usd')
await intent('issue by A', 'i-a', [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 1000 }], asA, [a])
await intent('issue by B', 'i-b-issue', [{ action: 'issue', target: ref('bobw'), symbol: usd, amount: 1000 }], asB, [b])
await intent('spend by B', 'i-b-spend', [{ action: 'transfer', source: ref('alice'), target: ref('bobw'), symbol: usd, amount: 10 }], asB, [b])
await step('balances alice', () => asA.wallet.getBalances('alice'))
await step('balances bobw', () => asA.wallet.getBalances('bobw'))
await step('wallet.read alice as B', () => asB.wallet.read('alice'))
