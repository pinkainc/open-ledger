// L1 scenario: money moves inside one ledger — issue, transfer, destroy, balances,
// and the failure paths around them.
//
// Intent processing may be asynchronous, so after each intent the scenario waits for
// a final status by polling DIRECT (the server without the recording proxy). Polling
// through the proxy would make the number of recorded exchanges depend on timing.
//
//   BASE=http://localhost:4610/api/v2 DIRECT=https://ldg-stg.one/api/v2 RUN=x tsx conformance/scenarios/l1.ts
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'

const BASE = process.env.BASE ?? 'http://localhost:4610/api/v2'
const DIRECT = process.env.DIRECT ?? BASE
const RUN = process.env.RUN ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14)
const LEDGER = `open-ledger-conf-${RUN}`

const keyPair = await createKeyPair()
const secure = {
  iss: keyPair.public,
  sub: `signer:${keyPair.public}`,
  aud: LEDGER,
  exp: 3600,
  createHsh: false,
  kid: keyPair.public,
  keyPair,
} as any
const mine = [{ action: 'any', signer: { public: keyPair.public } }]

const step = async (name: string, fn: () => Promise<any>) => {
  try {
    const out = await fn()
    console.log(`ok    ${name}${out?.intent ? ` [${out?.meta?.status ?? ''}]` : ''}`)
    return out
  } catch (e: any) {
    console.log(`error ${name}: ${e?.reason ?? e?.response?.data?.data?.reason ?? e?.message}`)
  }
}

await step('ledger.create', () =>
  new LedgerSdk({ server: BASE, secure })
    .ledger.init()
    .data({
      handle: LEDGER,
      signer: 'system',
      // What the official CLI sends. Without `config`, the reference ledger fails every
      // commit with core.unexpected-error (recorded 2026-09-26, see FINDINGS.md).
      config: { 'intent.expiryThresholdMinutes': 60, 'access.strategy': 'record-based' },
      access: [{ action: 'any', record: 'any' }],
    } as any)
    .hash()
    .sign([{ keyPair }])
    .send(),
)
const sdk = new LedgerSdk({ server: BASE, ledger: LEDGER, secure })
const direct = new LedgerSdk({ server: DIRECT, ledger: LEDGER, secure })

const create = (client: 'symbol' | 'wallet', data: Record<string, unknown>) =>
  (sdk as any)[client].init().data(data).hash().sign([{ keyPair }]).send()

await step('symbol.create usd', () => create('symbol', { handle: 'usd', factor: 100, access: mine }))
for (const w of ['alice', 'bob']) await step(`wallet.create ${w}`, () => create('wallet', { handle: w, access: mine }))

const FINAL = new Set(['completed', 'rejected'])
async function settle(handle: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const r: any = await direct.intent.read(handle)
      if (FINAL.has(r?.meta?.status)) return r.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}

async function intent(name: string, handle: string, claims: unknown[]) {
  await step(`intent.create ${name}`, () =>
    sdk.intent.init().data({ handle, claims, access: mine } as any).hash().sign([{ keyPair }]).send(),
  )
  console.log(`      settled: ${await settle(handle)}`)
  await step(`intent.read ${name}`, () => sdk.intent.read(handle))
}

const usd = { handle: 'usd' }
const w = (handle: string) => ({ handle })

await intent('issue', 'i-issue', [{ action: 'issue', target: w('alice'), symbol: usd, amount: 10000 }])
await step('balances alice', () => sdk.wallet.getBalances('alice'))

await intent('transfer', 'i-transfer', [{ action: 'transfer', source: w('alice'), target: w('bob'), symbol: usd, amount: 2500 }])
await step('balances alice', () => sdk.wallet.getBalances('alice'))
await step('balances bob', () => sdk.wallet.getBalances('bob'))

await intent('overdraw', 'i-overdraw', [{ action: 'transfer', source: w('alice'), target: w('bob'), symbol: usd, amount: 999999 }])
await step('balances alice after overdraw', () => sdk.wallet.getBalances('alice'))

await intent('destroy', 'i-destroy', [{ action: 'destroy', source: w('bob'), symbol: usd, amount: 500 }])
await step('balances bob after destroy', () => sdk.wallet.getBalances('bob'))

await intent('unknown target', 'i-ghost', [{ action: 'transfer', source: w('alice'), target: w('ghost'), symbol: usd, amount: 1 }])
await intent('unknown symbol', 'i-eur', [{ action: 'issue', target: w('alice'), symbol: { handle: 'eur' }, amount: 1 }])

// Two claims, the second one impossible: all-or-nothing means the first must not apply.
await intent('partial', 'i-partial', [
  { action: 'transfer', source: w('alice'), target: w('bob'), symbol: usd, amount: 100 },
  { action: 'transfer', source: w('bob'), target: w('alice'), symbol: usd, amount: 999999 },
])
await step('balances alice after partial', () => sdk.wallet.getBalances('alice'))
await step('balances bob after partial', () => sdk.wallet.getBalances('bob'))

await step('intent.create duplicate handle', () =>
  sdk.intent.init().data({ handle: 'i-issue', claims: [{ action: 'issue', target: w('alice'), symbol: usd, amount: 1 }], access: mine } as any).hash().sign([{ keyPair }]).send(),
)
await step('intent.create zero amount', () =>
  sdk.intent.init().data({ handle: 'i-zero', claims: [{ action: 'issue', target: w('alice'), symbol: usd, amount: 0 }], access: mine } as any).hash().sign([{ keyPair }]).send(),
)
await step('intent.create missing claims', () =>
  sdk.intent.init().data({ handle: 'i-noclaims', access: mine } as any).hash().sign([{ keyPair }]).send(),
)
await step('intent.read missing', () => sdk.intent.read('i-nope'))
await step('intent.list', () => sdk.intent.list())
