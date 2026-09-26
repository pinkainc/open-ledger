// L4 scenario: who may move what. Claim permissions (spend on the source wallet,
// issue on the symbol), `$record: owner` and `$circle` signer matchers, a status
// policy with a quorum, and a read with a token on a ledger whose rules name signers.
//
// The ledger's intent expiry is one minute: per the docs an intent that lacks a
// permission is not refused but waits until it expires.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { ref, scenario } from './common.js'

const { sdk, keyPair: a, step, create, intent, LEDGER, BASE } = await scenario({ expiryMinutes: 1, settleSeconds: 240 })
const b = await createKeyPair()
const usd = ref('usd'), w = ref
const onlyA = [{ action: 'any', signer: { public: a.public } }]
const onlyB = [{ action: 'any', signer: { public: b.public } }]

await create('symbol', { handle: 'usd', factor: 100 })
await step('signer.create b', () => (sdk.signer as any).init().data({ handle: 'b', public: b.public, format: 'ed25519-raw' }).hash().sign([{ keyPair: a }]).send())
await create('wallet', { handle: 'alice', access: onlyA })
await create('wallet', { handle: 'bobw', access: [...onlyB, ...onlyA] })
await create('wallet', { handle: 'carol', access: [{ action: 'any', signer: { $record: 'owner' } }] })
await create('wallet', { handle: 'dave', access: [{ action: 'any', signer: { $circle: 'ops' } }] })

await intent('issue by symbol owner', 'i-issue-a', [{ action: 'issue', target: w('alice'), symbol: usd, amount: 1000 }])
await intent('issue by non-owner', 'i-issue-b', [{ action: 'issue', target: w('bobw'), symbol: usd, amount: 1000 }], [b])
await intent('spend without permission', 'i-steal', [{ action: 'transfer', source: w('alice'), target: w('bobw'), symbol: usd, amount: 10 }], [b])
await intent('spend with both signatures', 'i-both', [{ action: 'transfer', source: w('alice'), target: w('bobw'), symbol: usd, amount: 10 }], [a, b])

await intent('fund carol', 'i-carol', [{ action: 'issue', target: w('carol'), symbol: usd, amount: 50 }])
await intent('spend as record owner', 'i-owner', [{ action: 'transfer', source: w('carol'), target: w('alice'), symbol: usd, amount: 5 }])

await step('circle.create ops', () => (sdk as any).circle.init().data({ handle: 'ops', access: onlyA }).hash().sign([{ keyPair: a }]).send())
await step('circle.signer add b', () =>
  (sdk as any).circle.with('ops').signer.init().data({ circle: 'ops', signer: 'b' }).hash().sign([{ keyPair: a }]).send(),
)
await intent('fund dave', 'i-dave', [{ action: 'issue', target: w('dave'), symbol: usd, amount: 50 }])
await intent('spend as circle member', 'i-circle', [{ action: 'transfer', source: w('dave'), target: w('alice'), symbol: usd, amount: 5 }], [b])

await step('policy.create status', () =>
  (sdk as any).policy
    .init()
    .data({ handle: 'wallet-active', schema: 'status', record: 'wallet', values: [{ status: 'active', quorum: [{ public: a.public }] }], access: onlyA })
    .hash()
    .sign([{ keyPair: a }])
    .send(),
)
const status = async (name: string, signer: any, value: string) => {
  const cur: any = (await sdk.wallet.read('bobw')).response.data
  return step(name, () => sdk.wallet.from(cur).sign([{ keyPair: signer, custom: { status: value } } as any]).send())
}
await status('status active by b (not in quorum)', b, 'active')
await status('status active by a (quorum)', a, 'active')
await status('status blocked by a (no rule)', a, 'blocked')
await step('wallet.read bobw', () => sdk.wallet.read('bobw'))

// A second ledger whose only rule names a signer: can that signer read with a token?
const L2 = `${LEDGER}-signer-only`
const secureL2 = { iss: a.public, sub: `signer:${a.public}`, aud: L2, exp: 3600, createHsh: false, kid: a.public, keyPair: a } as any
await step('ledger2.create', () =>
  new LedgerSdk({ server: BASE, secure: secureL2 })
    .ledger.init()
    .data({ handle: L2, signer: 'system', config: { 'intent.expiryThresholdMinutes': 60, 'access.strategy': 'record-based' }, access: onlyA } as any)
    .hash()
    .sign([{ keyPair: a }])
    .send(),
)
await step('ledger2.read with owner token', () => new LedgerSdk({ server: BASE, ledger: L2, secure: secureL2 }).ledger.read())
