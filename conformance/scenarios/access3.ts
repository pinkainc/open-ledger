// Follow-up to `access2`, where the ledger owner A could not create a symbol although
// the ledger rule `{any, signer: {public: A}}` names A's key. Hypothesis: signer
// matchers only match keys registered as signer records of the ledger. This scenario
// asks the same thing before and after registering A, then answers the questions
// access2 could not reach: what a registered B gets when spending A's wallet, and
// what `{action: read}` without a record grants.
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
      access: [...onlyA, { action: 'create', record: 'signer' }, { action: 'create', record: 'intent' }, { action: 'read' }],
    } as any)
    .hash()
    .sign([{ keyPair: a }])
    .send(),
)
const asA = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(a) })
const asB = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: auth(b) })
const anon = new LedgerSdk({ server: BASE, ledger: LEDGER })
const direct = new LedgerSdk({ server: process.env.DIRECT ?? BASE, ledger: LEDGER, secure: auth(a) })

const symbol = () => asA.symbol.init().data({ handle: 'usd', factor: 100, access: onlyA } as any).hash().sign([{ keyPair: a }]).send()
await step('symbol.create by unregistered A', symbol)
await step('signer.create a', () => asA.signer.init().data({ handle: 'a', public: a.public, format: 'ed25519-raw' } as any).hash().sign([{ keyPair: a }]).send())
await step('signer.create b', () => asB.signer.init().data({ handle: 'b', public: b.public, format: 'ed25519-raw' } as any).hash().sign([{ keyPair: b }]).send())
await step('symbol.create by registered A', symbol)
await step('wallet.create alice by A', () => asA.wallet.init().data({ handle: 'alice', access: onlyA } as any).hash().sign([{ keyPair: a }]).send())
await step('wallet.create bobw by A', () => asA.wallet.init().data({ handle: 'bobw', access: onlyA } as any).hash().sign([{ keyPair: a }]).send())

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
await step('balances alice as A', () => asA.wallet.getBalances('alice'))

await step('ledger.read anonymous', () => anon.ledger.read())
await step('wallet.read anonymous', () => anon.wallet.read('alice'))
await step('wallet.read as registered A', () => asA.wallet.read('alice'))
await step('ledger.read as B', () => asB.ledger.read())
