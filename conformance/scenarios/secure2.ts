// Generic `secure` rules (spec: GenericSecurityRule `{schema, public, secret}`; docs,
// about-bridges: `{schema: mtls, public: <certificate>, secret: <private key>}`).
// Questions: is a generic rule accepted with a secret reference, refused without one?
// Does the ledger still call a bridge whose rule it may not know (`mtls`, a made-up
// schema), and does any header come of it? A client certificate cannot be seen through
// the tunnel (its edge ends TLS), so what mtls does on the wire is unit-tested only.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges, type Decision } from '../bridge.js'
import { ref, scenario } from './common.js'

const { sdk, keyPair, step, create, LEDGER, secure } = await scenario()
const BASE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2').replace(/\/v2$/, '')
const keys = Object.fromEntries(await Promise.all(['mt', 'gen'].map(async (h) => [h, await createKeyPair()] as const)))

// A self-signed certificate made for this scenario alone, with its key. Both are
// public on purpose: the recording keeps request bodies, the repository is public, and
// the pair is trusted by nothing.
const cert = `-----BEGIN CERTIFICATE-----
MIIBrTCCAVOgAwIBAgIUA12Q19v8fIBF8TTIJ9t9lewITOMwCgYIKoZIzj0EAwIw
LDEqMCgGA1UEAwwhb3Blbi1sZWRnZXItY29uZm9ybWFuY2UtdGVzdC1vbmx5MB4X
DTI2MTAxMDE2NDgwNFoXDTM2MTAwNzE2NDgwNFowLDEqMCgGA1UEAwwhb3Blbi1s
ZWRnZXItY29uZm9ybWFuY2UtdGVzdC1vbmx5MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEnxOLjtK8FNE/4iDn8HcoRzw1TX9pEOjzitExyBIoarUDZhL849Nn7DdR
B0gR8Q4WXC/7XFT5+zoH/z1sDrcPNaNTMFEwHQYDVR0OBBYEFPzKetRFXxChWgBZ
w3iiKI/CPD31MB8GA1UdIwQYMBaAFPzKetRFXxChWgBZw3iiKI/CPD31MA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAO3e63FSyAWMfkIfDKP3/gzZ
3vXLvlNUtJ78ID0C8jejAiAgXjcW4czNx/ZlwuIFM1heOmsu9o88nQS8ZrJBhKVp
Wg==
-----END CERTIFICATE-----
`
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgSpTij8It0/D1A/vh
HiPuegIIFHCVazlRMgxASs0mNHahRANCAASfE4uO0rwU0T/iIOfwdyhHPDVNf2kQ
6POK0THIEihqtQNmEvzj02fsN1EHSBHxDhZcL/tcVPn7Ogf/PWwOtw81
-----END PRIVATE KEY-----
`

const prepared = (): Decision => ({ status: 'prepared' })
const seen = ['authorization', 'x-api-key', 'x-client-cert', 'x-ssl-client-cert']
const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/secure2.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [
    { handle: 'mt', prefix: '/mt', keyPair: keys.mt, decide: prepared, headers: seen },
    { handle: 'gen', prefix: '/gen', keyPair: keys.gen, decide: prepared, headers: seen },
  ],
})

const mine = [{ action: 'any', signer: { public: keyPair.public } }]
const bridge = (handle: string, data: Record<string, unknown>, secret?: Record<string, string>) =>
  step(`bridge.create ${handle}`, () =>
    (sdk as any).bridge
      .init()
      .data({ handle, schema: 'rest', config: { server: `${BASE_URL}/${handle}/v2` }, secure: [], access: mine, ...data })
      .meta({ proofs: [], ...(secret ? { secret } : {}) })
      .hash()
      .sign([{ keyPair }])
      .send(),
  )

// Refused shapes first: a plain secret, no public, an extra field.
await bridge('bad-plain', { secure: [{ schema: 'mtls', public: cert, secret: key }] })
await bridge('bad-nopublic', { secure: [{ schema: 'mtls', secret: '{{ secret.k }}' }] }, { k: key })
await bridge('bad-extra', { secure: [{ schema: 'mtls', public: cert, secret: '{{ secret.k }}', ca: 'x' }] }, { k: key })
await bridge('bad-nosecret', { secure: [{ schema: 'mtls', public: cert, secret: '{{ secret.missing }}' }] })

await bridge('mt', { secure: [{ schema: 'mtls', public: cert, secret: '{{ secret.mtlsKey }}' }] }, { mtlsKey: key })
await bridge('gen', { secure: [{ schema: 'api-key-v2', public: 'client-7', secret: '{{ secret.apiSecret }}' }] }, { apiSecret: 'generic-secret-1' })
await step('bridge.read mt', () => (sdk as any).bridge.read('mt'))
await step('bridge.read gen', () => (sdk as any).bridge.read('gen'))
for (const h of ['mt', 'gen'])
  await step(`signer.create ${h}`, () => (sdk as any).signer.init().data({ handle: h, public: keys[h].public, format: 'ed25519-raw', access: mine }).hash().sign([{ keyPair }]).send())

await create('symbol', { handle: 'usd', factor: 100 })
for (const [w, b] of [['alice'], ['acct-mt', 'mt'], ['acct-gen', 'gen']]) await create('wallet', { handle: w, ...(b ? { bridge: b } : {}) })

const poller: any = new LedgerSdk({ server: (process.env.DIRECT ?? process.env.BASE)!, ledger: LEDGER, secure })
async function settle(handle: string, seconds = 40) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const r: any = (await poller.intent.read(handle)).response.data
      if (['completed', 'rejected'].includes(r.meta.status)) return r.meta.status
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}
// A call that fails is given up after six attempts, ~8 s; waiting 15 s keeps a check
// run (where a minute of expiry is a second) clear of the intent's expiry.
async function move(name: string, handle: string, claims: unknown[], seconds = 40) {
  await step(`intent.create ${name}`, () => sdk.intent.init().data({ handle, claims } as any).hash().sign([{ keyPair }]).send())
  console.log(`      settled: ${await settle(handle, seconds)}`)
  await step(`intent.read ${name}`, () => sdk.intent.read(handle))
}
const usd = ref('usd')
const t = (source: string, target: string, amount: number) => ({ action: 'transfer', source: ref(source), target: ref(target), symbol: usd, amount })

await move('fund', 'i-fund', [{ action: 'issue', target: ref('alice'), symbol: usd, amount: 100 }])
await move('to the mtls bridge', 'i-mt', [t('alice', 'acct-mt', 1)], 15)
await move('to the generic bridge', 'i-gen', [t('alice', 'acct-gen', 2)], 15)
await step('events of mt', () => (sdk as any).bridge.with('mt').events.list())
await step('events of gen', () => (sdk as any).bridge.with('gen').events.list())

await new Promise((r) => setTimeout(r, 3000))
await bridges.close()
