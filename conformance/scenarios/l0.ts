// L0 scenario: ledger, symbol, wallet — records only, no money moves.
//
// Drives the official @minka/ledger-sdk against BASE, so the requests are exactly the
// ones a real Minka client sends. Point BASE at the recording proxy to capture what the
// reference ledger answers, or at our server to be judged against that capture.
//
//   BASE=http://localhost:4610/api/v2 RUN=20260926a tsx conformance/scenarios/l0.ts
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { operatorKeyPair } from '../identity.js'

const BASE = process.env.BASE ?? 'http://localhost:4610/api/v2'
const RUN = process.env.RUN ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14)
const LEDGER = `open-ledger-conf-${RUN}`

const keyPair = await operatorKeyPair()
const secure = (aud: string) => ({
  // Same claim shape the official CLI builds (sendIntent in @minka/cli 2.45.1).
  iss: keyPair.public,
  sub: `signer:${keyPair.public}`,
  aud,
  // The SDK adds this to `iat` itself: it is a lifetime in seconds, not an epoch.
  exp: 3600,
  createHsh: false,
  kid: keyPair.public,
  keyPair,
})

const step = async (name: string, fn: () => Promise<unknown>) => {
  try {
    const out = await fn()
    console.log(`ok    ${name}`)
    return out
  } catch (e: any) {
    const body = e?.response?.data ?? e?.cause?.response?.data
    console.log(`error ${name}: ${e?.response?.status ?? ''} ${JSON.stringify(body ?? e?.message)}`)
  }
}

const root = new LedgerSdk({ server: BASE, secure: secure(LEDGER) })

await step('ledger.create', () =>
  root.ledger
    .init()
    .data({ handle: LEDGER, signer: 'system', access: [{ action: 'any', record: 'any' }] } as any)
    .hash()
    .sign([{ keyPair }])
    .send(),
)

const sdk = new LedgerSdk({ server: BASE, ledger: LEDGER, secure: secure(LEDGER) })

await step('ledger.read', () => sdk.ledger.read())

await step('symbol.create', () =>
  sdk.symbol
    .init()
    .data({ handle: 'usd', factor: 100, access: [{ action: 'any', signer: { public: keyPair.public } }] } as any)
    .hash()
    .sign([{ keyPair }])
    .send(),
)
await step('symbol.read', () => sdk.symbol.read('usd'))
await step('symbol.list', () => sdk.symbol.list())

await step('wallet.create', () =>
  sdk.wallet
    .init()
    .data({ handle: 'alice', access: [{ action: 'any', signer: { public: keyPair.public } }] } as any)
    .hash()
    .sign([{ keyPair }])
    .send(),
)
await step('wallet.read', () => sdk.wallet.read('alice'))
await step('wallet.list', () => sdk.wallet.list())
await step('wallet.balances', () => sdk.wallet.getBalances('alice'))

// Error paths: these define behaviour at least as much as the happy path.
await step('wallet.read.missing', () => sdk.wallet.read('nobody'))
await step('wallet.create.duplicate', () =>
  sdk.wallet
    .init()
    .data({ handle: 'alice', access: [{ action: 'any', signer: { public: keyPair.public } }] } as any)
    .hash()
    .sign([{ keyPair }])
    .send(),
)
await step('wallet.create.unsigned', () =>
  sdk.wallet.init().data({ handle: 'bob' } as any).hash().send(),
)
await step('wallet.create.schema-invalid', () =>
  sdk.wallet
    .init()
    .data({ access: [] } as any)
    .hash()
    .sign([{ keyPair }])
    .send(),
)
await step('wallet.create.bad-signature', async () => {
  const other = await createKeyPair()
  const rec = sdk.wallet
    .init()
    .data({ handle: 'carol' } as any)
    .hash()
    .sign([{ keyPair: other }])
  await rec.read() // signing is queued; wait for it before tampering
  // A proof whose `public` claims our key but whose signature was made by another.
  ;(rec as any).record.meta.proofs[0].public = keyPair.public
  return rec.send()
})
await step('wallet.create.bad-hash', async () => {
  const rec = sdk.wallet.init().data({ handle: 'dave' } as any).hash().sign([{ keyPair }])
  await rec.read()
  // Data changed after hashing and signing: the hash no longer matches.
  ;(rec as any).record.data.handle = 'eve'
  return rec.send()
})
await step('ledger.read.no-token', () => new LedgerSdk({ server: BASE, ledger: LEDGER }).ledger.read())
await step('ledger.read.bad-token', () =>
  new LedgerSdk({ server: BASE, ledger: LEDGER, secure: { overrideToken: 'not-a-token' } as any }).ledger.read(),
)
await step('ledger.read.unknown-ledger', () =>
  new LedgerSdk({ server: BASE, ledger: `${LEDGER}-nope`, secure: secure(LEDGER) }).ledger.read(),
)
