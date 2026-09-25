// Test harness: our server on an ephemeral port, driven by the official Minka SDK, so
// unit tests exercise the same contract real clients depend on.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { buildApp } from '../src/app.js'
import { MemoryStore } from '../src/store.js'
import type { Store } from '../src/store.js'

export type KeyPair = Awaited<ReturnType<typeof createKeyPair>>

export async function startServer(store: Store = new MemoryStore()) {
  const app = buildApp({ store })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as { port: number }
  return { app, base: `http://127.0.0.1:${port}/api/v2`, close: () => app.close() }
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
export async function newLedger(base: string, keyPair: KeyPair, access: unknown[] = [{ action: 'any', record: 'any' }]) {
  const handle = `test-${process.pid}-${++counter}`
  // The SDK refuses to create a ledger while one is active, so no `ledger` here.
  await sdkFor(base, undefined, keyPair, handle)
    .ledger.init()
    .data({ handle, signer: 'system', access } as any)
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
