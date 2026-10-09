// Drop of bridges and policies (spec: dropBridge, dropPolicy, both by DELETE and by
// POST …/drop). Open questions: may a bridge a wallet names be dropped, and a system
// policy? What does a read, a list and the referring wallet show afterwards?
import { scenario } from './common.js'

const { sdk, keyPair, step, mine } = await scenario()
const s: any = sdk
const make = (client: string, data: Record<string, unknown>) =>
  step(`${client}.create ${data.handle}`, () => s[client].init().data({ access: mine, ...data }).hash().sign([{ keyPair }]).send())
const drop = (client: string, handle: string) => step(`${client}.drop ${handle}`, () => s[client].drop(handle).hash().sign([{ keyPair }]).send())

await make('bridge', { handle: 'idle', schema: 'rest', config: { server: 'http://127.0.0.1:9/v2' }, secure: [] })
await make('bridge', { handle: 'used', schema: 'rest', config: { server: 'http://127.0.0.1:9/v2' }, secure: [] })
await make('wallet', { handle: 'acc', bridge: 'used' })
await drop('bridge', 'idle')
await step('bridge.read idle after drop', () => s.bridge.read('idle'))
await drop('bridge', 'used')
await step('bridge.read used', () => s.bridge.read('used'))
await step('wallet.read acc', () => s.wallet.read('acc'))
await step('bridge.list', () => s.bridge.list())

await make('policy', { handle: 'p-status', schema: 'status', record: 'wallet', values: [] })
await drop('policy', 'p-status')
await step('policy.read p-status after drop', () => s.policy.read('p-status'))
await drop('policy', 'intent:status')
await step('policy.list', () => s.policy.list())
