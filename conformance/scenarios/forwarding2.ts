// `filter` on processing policies (connecting-systems/processing-policies: "record must
// match the filter for the policy to apply"; moving-money/anchor-forwarding: a value's
// filter overrides the root one, `new.data.schema` on a create). Which context a filter
// sees is not written down, so each phase tries one form on `create` with `proxy`: a
// proxied anchor is not kept, so a local read tells whether the policy applied, and the
// bridge log shows the call. One policy per phase, dropped after it.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { scenario } from './common.js'

const { sdk, keyPair, step, create, mine, LEDGER } = await scenario()
const s: any = sdk
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2'
const dirKey = await createKeyPair()

// The directory keeps nothing: it answers a create with the anchor it was sent.
function serve(method: string, path: string, body: any) {
  if (method === 'POST' && /^\/v2\/anchors$/.test(path)) return { status: 201, signed: { data: body.data, meta: { proofs: body?.meta?.proofs ?? [] }, luid: `$anc.dir-${body?.data?.handle}` } }
  return undefined
}

const bridge = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/forwarding2.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [{ handle: 'dir', keyPair: dirKey, decide: () => ({ status: 'prepared' }), serve, headers: ['authorization', 'x-forwarded-authorization', 'x-ledger'] }],
})

await step('bridge.create dir', () =>
  s.bridge.init().data({ handle: 'dir', schema: 'rest', config: { server: BRIDGE_URL.replace(/\/v2$/, '') }, secure: [], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create dir', () => s.signer.init().data({ handle: 'dir', public: dirKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send())
await create('wallet', { handle: 'alice' })

const proxy = (filter?: unknown, strategy = 'proxy') => ({ schema: 'aspect', action: 'create', invoke: { bridge: 'dir' }, config: { strategy }, ...(filter ? { filter } : {}) })
const make = (handle: string, rail: string) =>
  step(`anchor.create ${handle} rail ${rail}`, () => s.anchor.init().data({ handle, wallet: 'alice', target: 'alice', custom: { rail }, access: mine }).hash().sign([{ keyPair }]).send())
const read = (handle: string) => step(`anchor.read ${handle}`, () => s.anchor.read(handle))

async function phase(handle: string, root: unknown, values: unknown[], rails: string[]) {
  await step(`policy.create ${handle}`, () =>
    s.policy.init().data({ handle, schema: 'processing', record: 'anchor', ...(root ? { filter: root } : {}), values, access: mine }).hash().sign([{ keyPair }]).send(),
  )
  for (const r of rails) await make(`${handle}-${r}`, r)
  for (const r of rails) await read(`${handle}-${r}`)
  await step(`policy.drop ${handle}`, () => s.policy.drop(handle).hash().sign([{ keyPair }]).send())
}

// Root filter, on the record and relative to its data.
await phase('pa', { 'data.custom.rail': 'r1' }, [proxy()], ['r1', 'r2'])
await phase('pb', { 'custom.rail': 'r1' }, [proxy()], ['r1', 'r2'])
// A value's filter: `new.` as the docs write it, then like the root one.
await phase('pc', undefined, [proxy({ 'new.data.custom.rail': 'r1' })], ['r1', 'r2'])
await phase('pd', undefined, [proxy({ 'data.custom.rail': 'r1' })], ['r1', 'r2'])
// Root r1, value r2: does the value's override the root's, or must both match?
await phase('pe', { 'data.custom.rail': 'r1' }, [proxy({ 'data.custom.rail': 'r2' })], ['r1', 'r2'])
// Two create values told apart by their filters (two without filters are a 500, forwarding).
await phase('pf', undefined, [proxy({ 'data.custom.rail': 'r1' }), proxy({ 'data.custom.rail': 'r2' }, 'validate')], ['r1', 'r2', 'r3'])
// The same with `new.` everywhere (the first recording: only a value's `new.` matched).
await phase('pg', { 'new.data.custom.rail': 'r1' }, [proxy()], ['r1', 'r2'])
await phase('ph', { 'new.data.custom.rail': 'r1' }, [proxy({ 'new.data.custom.rail': 'r2' })], ['r1', 'r2'])
await phase('pi', undefined, [proxy({ 'new.data.custom.rail': 'r1' }), proxy({ 'new.data.custom.rail': 'r2' }, 'validate')], ['r1', 'r2', 'r3'])

await new Promise((r) => setTimeout(r, 1000))
await bridge.close()
