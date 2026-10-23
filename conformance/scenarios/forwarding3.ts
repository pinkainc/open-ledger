// The filter context of processing policies for every action but `create` (forwarding2
// recorded `new` on create). The docs give `new.data.schema` (anchor-forwarding),
// `data.schema` (processing-policies), `ctx.req.headers` and `_request.headers.…`, and
// for status policies `old`, `new`, `ctx.req` and `old.data` spread at the root.
//
// Each phase: an anchor `<phase>` with `custom.rail: r1`, then one `processing` policy
// whose only value proxies one action under one candidate filter, the action, the policy
// dropped. The directory knows no anchor, so a proxied action answers the bridge's 404
// and leaves the local anchor as it was; an unproxied one is local. The bridge log shows
// each call. `x-ledger` is a header the SDK sends on every request.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { scenario } from './common.js'

const { sdk, keyPair, step, create, mine, LEDGER } = await scenario()
const s: any = sdk
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2'
const dirKey = await createKeyPair()

// An empty directory: every anchor call is a 404, a list is empty.
function serve(method: string, path: string) {
  const m = path.match(/^\/v2\/anchors(?:\/([^/?]+))?(\/proofs)?(\?.*)?$/)
  if (!m) return undefined
  if (method === 'GET' && !m[1]) return { status: 200, signed: { data: [] } }
  return { status: 404, signed: { data: { reason: 'record.not-found', detail: 'Not in the directory' } } }
}

const bridge = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/forwarding3.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [{ handle: 'dir', keyPair: dirKey, decide: () => ({ status: 'prepared' }), serve, headers: ['authorization', 'x-forwarded-authorization', 'x-ledger'] }],
})

await step('bridge.create dir', () =>
  s.bridge.init().data({ handle: 'dir', schema: 'rest', config: { server: BRIDGE_URL.replace(/\/v2$/, '') }, secure: [], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create dir', () => s.signer.init().data({ handle: 'dir', public: dirKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send())
await create('wallet', { handle: 'alice' })

const anchor = (handle: string) => ({ handle, wallet: 'alice', target: 'alice', custom: { rail: 'r1' }, access: mine })
const local = async (handle: string) => (await s.anchor.read(handle)).response.data
const ops: Record<string, (h: string) => Promise<unknown>> = {
  read: (h) => s.anchor.read(h),
  query: () => s.anchor.list(),
  update: async (h) => s.anchor.from(await local(h)).data({ custom: { rail: 'r1', v: 2 } }).hash().sign([{ keyPair }]).send(),
  sign: async (h) => s.anchor.from(await local(h)).sign([{ keyPair, custom: { status: 'inactive' } }]).send(),
  drop: (h) => s.anchor.drop(h).hash().sign([{ keyPair }]).send(),
  create: (h) => s.anchor.init().data(anchor(h)).hash().sign([{ keyPair }]).send(),
}

const CANDIDATES: [string, Record<string, unknown>][] = [
  ['old', { 'old.data.custom.rail': 'r1' }],
  ['new', { 'new.data.custom.rail': 'r1' }],
  ['data', { 'data.custom.rail': 'r1' }],
  ['root', { 'custom.rail': 'r1' }],
  ['ctx-header', { 'ctx.req.headers.x-ledger': LEDGER }],
  ['req-header', { '_request.headers.x-ledger': LEDGER }],
  ['ctx-method', { 'ctx.req.method': { $in: ['GET', 'POST', 'PUT', 'DELETE'] } }],
]

let n = 0
for (const action of Object.keys(ops)) {
  for (const [name, filter] of CANDIDATES) {
    if (action === 'create' && ['new', 'data', 'root'].includes(name)) continue // forwarding2
    const h = `p${++n}`
    if (action !== 'create') await step(`anchor.create ${h}`, () => s.anchor.init().data(anchor(h)).hash().sign([{ keyPair }]).send())
    const values = [{ schema: 'aspect', action, invoke: { bridge: 'dir' }, config: { strategy: 'proxy' }, filter }]
    await step(`policy.create ${h} ${action} ${name}`, () =>
      s.policy.init().data({ handle: h, schema: 'processing', record: 'anchor', values, access: mine }).hash().sign([{ keyPair }]).send(),
    )
    await step(`${action} ${h} under ${name}`, () => ops[action](h))
    await step(`policy.drop ${h}`, () => s.policy.drop(h).hash().sign([{ keyPair }]).send())
    if (action !== 'read' && action !== 'query') await step(`anchor.read ${h} after`, () => s.anchor.read(h))
  }
}

await new Promise((r) => setTimeout(r, 1000))
await bridge.close()
