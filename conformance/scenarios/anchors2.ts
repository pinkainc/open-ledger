// Anchors and domains a bridge serves (about-wallets: wallet anchors and domains;
// about-bridges: traits `anchors`, `domains`). The docs name four different paths for
// the call the ledger makes, so the bridge answers whatever it is asked (that is not a
// prepare, commit, abort or status) with a signed list, and logs the call.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { scenario } from './common.js'

const { sdk, keyPair, step, create, mine, LEDGER } = await scenario()
const s: any = sdk
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2'
const bankKey = await createKeyPair()

const bridge = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/anchors2.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [
    {
      handle: 'bank',
      keyPair: bankKey,
      decide: () => ({ status: 'prepared' }),
      lists: (_method, path) =>
        // A list of records' data, signed by the bridge (about-bridges, "Other traits endpoints").
        path.includes('domain')
          ? [{ handle: 'branch-1@acc' }]
          : [{ handle: 'tel:9', wallet: 'acc', target: 'acc:9', custom: { from: 'bank' } }],
    },
  ],
})

await step('bridge.create bank', () =>
  s.bridge.init().data({ handle: 'bank', schema: 'rest', config: { server: BRIDGE_URL }, secure: [], traits: ['debits', 'credits', 'anchors', 'domains'], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('bridge.create plain', () =>
  s.bridge.init().data({ handle: 'plain', schema: 'rest', config: { server: `${BRIDGE_URL}/plain` }, secure: [], traits: ['debits', 'credits'], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create bank', () =>
  s.signer.init().data({ handle: 'bank', public: bankKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send(),
)
await create('wallet', { handle: 'acc', bridge: 'bank' })
await create('wallet', { handle: 'acc2', bridge: 'plain' })
await create('wallet', { handle: 'alice' })
await step('anchor.create local', () => s.anchor.init().data({ handle: 'local-1', wallet: 'acc', target: 'acc:1', access: mine }).hash().sign([{ keyPair }]).send())

await step('wallet.anchors acc', () => s.wallet.getAnchors('acc'))
await step('wallet.anchors tel:9@acc', () => s.wallet.getAnchors('tel:9@acc'))
await step('wallet.anchors acc2 (no trait)', () => s.wallet.getAnchors('acc2'))
await step('wallet.anchors alice (no bridge)', () => s.wallet.getAnchors('alice'))
const lookup = (wallet: string, data: Record<string, unknown>) =>
  step(`wallet.anchors lookup ${wallet} ${JSON.stringify(data)}`, () => s.wallet.with(wallet).anchor.lookup().data(data).hash().sign([{ keyPair }]).send())
await lookup('acc', { wallet: 'acc', target: 'tel:9' })
await lookup('tel:9@acc', { wallet: 'tel:9@acc' })
await lookup('acc', { wallet: 'other' })
await lookup('alice', { wallet: 'alice', target: 'tel:9' })
await step('wallet.domains acc', () => s.wallet.getDomains('acc'))
await step('wallet.domains x@acc', () => s.wallet.getDomains('x@acc'))
await step('wallet.domains alice', () => s.wallet.getDomains('alice'))

await new Promise((r) => setTimeout(r, 1000))
await bridge.close()
