// Generic record lifecycle, the same for every record kind: update (PUT with a parent
// hash), status change by proof, change history, access check, drop — plus signers and
// the ledger list.
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { sdk, keyPair, step, create } = await scenario()

await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice', custom: { tier: 'silver' } })
await create('wallet', { handle: 'bob' })

// Update: the SDK links data.parent to the current hash and PUTs the new version.
const alice: any = await sdk.wallet.read('alice')
const aliceRecord = alice.response.data
await step('wallet.update alice', () =>
  sdk.wallet.from(aliceRecord).data({ custom: { tier: 'gold' } } as any).hash().sign([{ keyPair }]).send(),
)
await step('wallet.read alice after update', () => sdk.wallet.read('alice'))
await step('wallet.update alice from stale parent', () =>
  sdk.wallet.from(aliceRecord).data({ custom: { tier: 'platinum' } } as any).hash().sign([{ keyPair }]).send(),
)

// Status change: a proof whose custom carries the new status, sent to /proofs.
const current: any = (await sdk.wallet.read('alice')).response.data
await step('wallet.status inactive', () =>
  sdk.wallet.from(current).sign([{ keyPair, custom: { status: 'inactive' } } as any]).send(),
)
await step('wallet.read alice after status', () => sdk.wallet.read('alice'))

await step('wallet.changes alice', () => (sdk.wallet as any).with('alice').change.list())
await step('wallet.change 1', () => (sdk.wallet as any).with('alice').change.read(1))

await step('wallet.access check read', () =>
  (sdk.wallet as any).with('alice').access.check().data({ action: 'read' }).hash().sign([{ keyPair }]).send(),
)

await step('wallet.drop bob', () => sdk.wallet.drop('bob').hash().sign([{ keyPair }]).send())
await step('wallet.read bob after drop', () => sdk.wallet.read('bob'))
await step('wallet.list after drop', () => sdk.wallet.list())

const symbol: any = (await sdk.symbol.read('usd')).response.data
await step('symbol.update custom', () =>
  sdk.symbol.from(symbol).data({ custom: { name: 'US dollar' } } as any).hash().sign([{ keyPair }]).send(),
)

const other = await createKeyPair()
await step('signer.create ops', () =>
  (sdk.signer as any).init().data({ handle: 'ops', public: other.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send(),
)
await step('signer.read ops', () => sdk.signer.read('ops'))
await step('signer.list', () => sdk.signer.list())
