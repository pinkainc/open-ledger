// Shared scaffolding for scenarios from L3 on: a fresh ledger configured like the
// official CLI configures one, an SDK through the recording proxy (BASE), and one
// that bypasses it (DIRECT) for polling, whose request count depends on timing.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'

export async function scenario() {
  const BASE = process.env.BASE ?? 'http://localhost:4610/api/v2'
  const DIRECT = process.env.DIRECT ?? BASE
  const RUN = process.env.RUN ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const LEDGER = `open-ledger-conf-${RUN}`

  const keyPair = await createKeyPair()
  const secure = { iss: keyPair.public, sub: `signer:${keyPair.public}`, aud: LEDGER, exp: 3600, createHsh: false, kid: keyPair.public, keyPair } as any
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
    step(`${client}.create ${data.handle}`, () => (sdk as any)[client].init().data({ access: mine, ...data }).hash().sign([{ keyPair }]).send())

  async function settle(handle: string) {
    for (let i = 0; i < 60; i++) {
      try {
        const r: any = await direct.intent.read(handle)
        if (r?.meta?.status === 'completed' || r?.meta?.status === 'rejected') return r.meta.status
      } catch {}
      await new Promise((r) => setTimeout(r, 500))
    }
    return 'timeout'
  }

  /** Create an intent, wait for it off the record, then read it on the record. */
  async function intent(name: string, handle: string, claims: unknown[]) {
    await step(`intent.create ${name}`, () => sdk.intent.init().data({ handle, claims, access: mine } as any).hash().sign([{ keyPair }]).send())
    console.log(`      settled: ${await settle(handle)}`)
    return step(`intent.read ${name}`, () => sdk.intent.read(handle))
  }

  return { sdk, keyPair, mine, step, create, intent, LEDGER }
}

export const ref = (handle: string) => ({ handle })
