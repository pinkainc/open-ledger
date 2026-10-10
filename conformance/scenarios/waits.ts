// What moves an intent that waits for a signature (TODO L4). In records2 B spent
// alice without `spend` and A's plain signature did not restart it. Here A signs three
// such intents differently: with `custom.status: pending`, with `created`, and plainly
// again; a fourth is sent again by B as a new create signed by both. Each is read after
// a while. Also the error of dropping a funded wallet.
//
// Ledger rules as in records2: A may do anything, B may enter and create intents,
// everyone may read. Expiry five minutes, so nothing is left pending on the reference.
// Checking, a minute is 12 s: the intents must still wait when they are read.
// minute-ms: 12000
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario, ref } from './common.js'

const opts = { expiryMinutes: 5 }
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
const current = async (client: any, id: string) => (await client.read(id)).response.data
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

await step('symbol.create usd', () => asA.symbol.init().data({ handle: 'usd', factor: 100, access: onlyA }).hash().sign([{ keyPair: a }]).send())
for (const h of ['alice', 'bobw', 'empty'])
  await step(`wallet.create ${h}`, () => asA.wallet.init().data({ handle: h, access: onlyA }).hash().sign([{ keyPair: a }]).send())

async function poll(handle: string, done: (i: any) => boolean, seconds: number) {
  for (let n = 0; n < seconds * 2; n++) {
    try {
      const i: any = (await direct.intent.read(handle)).response.data
      if (done(i)) return i.meta.status
    } catch {}
    await sleep(500)
  }
  return 'timeout'
}
const final = (i: any) => ['completed', 'rejected'].includes(i.meta.status)
const resolved = (i: any) => final(i) || i.meta.proofs.some((p: any) => p.custom?.status === 'resolved')

await step('intent.create issue by A', () =>
  asA.intent.init().data({ handle: 'i-a', claims: [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 1000 }] }).hash().sign([{ keyPair: a }]).send(),
)
console.log(`      settled: ${await poll('i-a', final, 30)}`)

// B spends alice without `spend`; each intent waits. A then signs it, differently each time.
const spend = (handle: string, amount: number) =>
  step(`intent.create ${handle} by B`, () =>
    asB.intent.init().data({ handle, claims: [{ action: 'transfer', source: ref('alice'), target: ref('bobw'), symbol: ref('usd'), amount }] }).hash().sign([{ keyPair: b }]).send(),
  )
const signs: [string, Record<string, unknown> | undefined][] = [
  ['i-pending', { status: 'pending' }],
  ['i-created', { status: 'created' }],
  ['i-plain', undefined],
]
for (const [handle] of signs) {
  await spend(handle, 10)
  console.log(`      resolved: ${await poll(handle, resolved, 30)}`)
}
for (const [handle, custom] of signs)
  await step(`intent.sign ${handle} by A ${JSON.stringify(custom ?? {})}`, async () =>
    asA.intent.from(await current(asA.intent, handle)).sign([{ keyPair: a, ...(custom ? { custom } : {}) }]).send(),
  )
// The same intent again, signed by B and A: a second create of the handle.
await spend('i-resend', 10)
console.log(`      resolved: ${await poll('i-resend', resolved, 30)}`)
await step('intent.create i-resend by B and A', () =>
  asB.intent.init().data({ handle: 'i-resend', claims: [{ action: 'transfer', source: ref('alice'), target: ref('bobw'), symbol: ref('usd'), amount: 10 }] }).hash().sign([{ keyPair: b }, { keyPair: a }]).send(),
)
// The reference processes an intent within a second or two; ten seconds shows whether it moved.
await sleep(10_000)
for (const handle of [...signs.map(([h]) => h), 'i-resend']) await step(`intent.read ${handle} after A signed`, () => asA.intent.read(handle))
await step('balances bobw', () => asA.wallet.getBalances('bobw'))

// ---- dropping wallets ---------------------------------------------------------------
await step('wallet.drop alice (funded)', () => asA.wallet.drop('alice').hash().sign([{ keyPair: a }]).send())
await step('wallet.read alice after drop', () => asA.wallet.read('alice'))
await step('wallet.drop empty', () => asA.wallet.drop('empty').hash().sign([{ keyPair: a }]).send())
await step('wallet.read empty after drop', () => asA.wallet.read('empty'))
