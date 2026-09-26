// Test harness: our server on an ephemeral port, driven by the official Minka SDK, so
// unit tests exercise the same contract real clients depend on.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { buildApp } from '../src/app.js'
import { Core } from '../src/core.js'
import { MemoryStore } from '../src/store.js'
import { PgStore } from '../src/pg-store.js'
import type { Store } from '../src/store.js'

export type KeyPair = Awaited<ReturnType<typeof createKeyPair>>

/** Stores to run behaviour tests against: memory always, Postgres when DATABASE_URL is set. */
export const STORES: [string, () => Promise<Store & { close?: () => Promise<void> }>][] = [['memory', async () => new MemoryStore()]]
if (process.env.DATABASE_URL) STORES.push(['postgres', () => PgStore.connect(process.env.DATABASE_URL!)])

export async function startServer(store: Store & { close?: () => Promise<void> } = new MemoryStore(), core = new Core(store)) {
  const app = buildApp({ store, core })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as { port: number }
  return {
    app,
    core,
    base: `http://127.0.0.1:${port}/api/v2`,
    close: async () => {
      core.close()
      await app.close()
      await store.close?.()
    },
  }
}

export const newKeyPair = () => createKeyPair()

export function sdkFor(base: string, ledger: string | undefined, keyPair?: KeyPair, aud = ledger) {
  return new LedgerSdk({
    server: base,
    ledger,
    secure: keyPair
      ? ({ iss: keyPair.public, sub: `signer:${keyPair.public}`, aud: aud ?? 'unknown', exp: 3600, createHsh: false, kid: keyPair.public, keyPair } as any)
      : undefined,
  })
}

let counter = 0
export async function newLedger(base: string, keyPair: KeyPair, access: unknown[] = [{ action: 'any', record: 'any' }], config?: Record<string, unknown>) {
  const handle = `test-${process.pid}-${++counter}`
  // The SDK refuses to create a ledger while one is active, so no `ledger` here.
  await sdkFor(base, undefined, keyPair, handle)
    .ledger.init()
    .data({ handle, signer: 'system', access, ...(config ? { config } : {}) } as any)
    .hash()
    .sign([{ keyPair }])
    .send()
  return { handle, sdk: sdkFor(base, handle, keyPair) }
}

/** Runs a request that must fail and returns the ledger's error body. */
export async function failure(p: Promise<unknown>): Promise<{ status: number; reason: string; detail: string; body: any }> {
  try {
    await p
  } catch (e: any) {
    // The SDK wraps HTTP errors in LedgerApiError; the axios error is kept in custom.causedBy.
    const res = e?.custom?.causedBy?.response ?? e?.response
    if (res) return { status: res.status, reason: res.data?.data?.reason, detail: res.data?.data?.detail, body: res.data }
    throw e
  }
  throw new Error('expected the request to fail')
}

const FINAL = new Set(['completed', 'rejected'])

/** Waits until an intent reaches a final status and returns the intent record. */
export async function settle(sdk: any, handle: string, timeoutMs = 10_000): Promise<any> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const r: any = await sdk.intent.read(handle)
    if (FINAL.has(r?.meta?.status)) return r
    if (Date.now() > until) throw new Error(`intent ${handle} still ${r?.meta?.status}`)
    await new Promise((res) => setTimeout(res, 10))
  }
}

export const ref = (handle: string) => ({ handle })

/** Creates a symbol and wallets owned by `keyPair`. */
export async function setupBooks(sdk: any, keyPair: KeyPair, wallets: string[], symbol = 'usd') {
  const mine = [{ action: 'any', signer: { public: keyPair.public } }]
  await sdk.symbol.init().data({ handle: symbol, factor: 100, access: mine }).hash().sign([{ keyPair }]).send()
  for (const w of wallets) await sdk.wallet.init().data({ handle: w, access: mine }).hash().sign([{ keyPair }]).send()
}

let intentSeq = 0
export async function sendIntent(sdk: any, keyPair: KeyPair, claims: unknown[], handle = `i-${process.pid}-${++intentSeq}`) {
  await sdk.intent.init().data({ handle, claims }).hash().sign([{ keyPair }]).send()
  return handle
}

/** `{schema: amount}` for one wallet and symbol. */
export async function balanceOf(sdk: any, wallet: string, symbol = 'usd') {
  const res: any = await sdk.wallet.getBalances(wallet)
  const out: Record<string, number> = { available: 0, reserved: 0 }
  for (const b of res.balances ?? res.data ?? []) {
    const d = b.data ?? b
    if (d.symbol === symbol) out[d.schema] = d.amount
  }
  return out
}
