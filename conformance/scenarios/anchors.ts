// Anchors as records (about-anchors; spec createAnchor … dropAnchor, readWalletAnchors):
// an alias that points at payment details, with or without a wallet. Then the ledger
// option `anchor.walletRequired`: anchors must name an existing wallet, and a wallet
// with anchors cannot be dropped. No bridge here: wallet anchors are local only.
import { scenario } from './common.js'

const { sdk, keyPair, step, create, mine } = await scenario()
const s: any = sdk
const make = (data: Record<string, unknown>, label = `anchor.create ${data.handle}`) =>
  step(label, () => s.anchor.init().data({ access: mine, ...data }).hash().sign([{ keyPair }]).send())

await create('symbol', { handle: 'usd', factor: 100 })
await create('wallet', { handle: 'alice' })
await create('wallet', { handle: 'bob' })

await make({ handle: 'tel:385911', wallet: 'alice', target: 'alice', symbol: 'usd', custom: { name: 'Alice' } })
await make({ handle: 'mail:bob', wallet: 'bob', target: { handle: 'acc:123', custom: { bank: 'hpb' } } })
await make({ handle: 'loose', target: 'nowhere' })
await make({ handle: 'no-target', wallet: 'alice' })
await make({ handle: 'tel:385911', wallet: 'bob', target: 'bob' }, 'anchor.create duplicate')
await make({ handle: 'extra', target: 'alice', amount: 5, colour: 'red' }, 'anchor.create unknown property')
await step('anchor.read tel:385911', () => s.anchor.read('tel:385911'))
await step('anchor.list', () => s.anchor.list())
await step('anchor.list data.wallet=alice', () => s.anchor.list({ 'data.wallet': 'alice' }))

const tel: any = (await s.anchor.read('tel:385911')).response.data
await step('anchor.update tel:385911', () => s.anchor.from(tel).data({ custom: { name: 'Alice A.' } }).hash().sign([{ keyPair }]).send())
await step('anchor.changes tel:385911', () => s.anchor.with('tel:385911').change.list())
await step('anchor.status inactive', async () => {
  const cur: any = (await s.anchor.read('tel:385911')).response.data
  return s.anchor.from(cur).sign([{ keyPair, custom: { status: 'inactive' } }]).send()
})

await step('wallet.anchors alice', () => s.wallet.getAnchors('alice'))
await step('wallet.anchors nobody', () => s.wallet.getAnchors('nobody'))

await step('anchor.drop loose', () => s.anchor.drop('loose').hash().sign([{ keyPair }]).send())
await step('anchor.read loose after drop', () => s.anchor.read('loose'))

// anchor.walletRequired
const ledger: any = (await s.ledger.read()).response.data
await step('ledger.update anchor.walletRequired', () =>
  s.ledger.from(ledger).data({ config: { ...ledger.data.config, 'anchor.walletRequired': true } }).hash().sign([{ keyPair }]).send(),
)
await make({ handle: 'req-none', target: 'x' })
await make({ handle: 'req-unknown', wallet: 'ghost', target: 'x' })
await make({ handle: 'req-ok', wallet: 'bob', target: 'x' })
await step('wallet.drop bob with anchors', () => s.wallet.drop('bob').hash().sign([{ keyPair }]).send())
