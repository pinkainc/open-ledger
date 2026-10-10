// Anchor forwarding by a processing policy (connecting-systems/processing-policies,
// moving-money/anchor-forwarding). A bridge `dir` is an alias directory: it keeps the
// anchors it is sent and answers the ledger's anchor API, signed by its key. Some
// handles make it misbehave, to see what the ledger makes of the answer.
//
// Phases: policy validation (no calls), then every action `proxy`, then writes
// `validate` and reads `fallback`, then writes `synchronize`. One policy, updated.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { hashData } from '../../server/src/crypto.js'
import { scenario } from './common.js'

const { sdk, keyPair, step, create, mine, LEDGER } = await scenario()
const s: any = sdk
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2'
const dirKey = await createKeyPair()

// The directory: anchors by handle, as last sent.
const kept = new Map<string, { data: any; meta: any; luid?: string }>()
const notFound = (id: string) => ({ status: 404, signed: { data: { reason: 'record.not-found', detail: `Anchor ${id} is not in the directory` } } })
const found = (id: string) => kept.get(id) ?? [...kept.values()].find((a) => a.luid === id)
const answer = (a: { data: any; meta: any; luid?: string }, status = 200) => ({ status, signed: { data: a.data, meta: a.meta, luid: a.luid } })
// A record as the directory lists it, signed by whoever signed it.
const listed = (a: { data: any; meta: any; luid?: string }) => ({ hash: hashData(a.data), data: a.data, luid: a.luid, meta: a.meta })

function serve(method: string, path: string, body: any) {
  const m = path.match(/^\/v2\/anchors(?:\/([^/?]+))?(\/proofs)?(\?.*)?$/)
  if (!m) return undefined
  const id = m[1] && decodeURIComponent(m[1])
  if (method === 'POST' && !id) {
    const h = body?.data?.handle
    if (h === 'bad-shape') return { status: 400, body: { error: 'not an anchor' } }
    if (h === 'bad-proof') return { status: 201, body: { hash: '0'.repeat(64), data: body.data, meta: { proofs: [] } } }
    if (h === 'unauthorized') return { status: 401, signed: { data: { reason: 'auth.unauthorized', detail: 'Who are you?' } } }
    if (h?.startsWith('refused')) return { status: 422, signed: { data: { reason: 'record.duplicated', detail: `Alias ${h} is taken`, custom: { by: 'someone' } } } }
    // The directory names a record by the ledger's luid when it has one, else its own.
    const a = { data: h === 'syn-mut' ? { ...body.data, custom: { directory: 'dir-7' } } : body.data, meta: { proofs: body?.meta?.proofs ?? [] }, luid: body?.luid ?? `$anc.dir-${h}` }
    kept.set(h, a)
    return answer(a, 201)
  }
  if (method === 'GET' && !id) return { status: 200, signed: { data: [...kept.values()].map(listed) } }
  const a = found(id!)
  if (!a) return notFound(id!)
  if (method === 'GET') return answer(a)
  if (method === 'PUT') {
    Object.assign(a, { data: body?.data ?? a.data, meta: { proofs: body?.meta?.proofs ?? a.meta.proofs } })
    return answer(a)
  }
  if (method === 'POST' && m[2]) {
    a.meta = { ...a.meta, proofs: [...a.meta.proofs, ...(Array.isArray(body) ? body : [body])] }
    return answer(a)
  }
  if (method === 'DELETE') {
    kept.delete(a.data.handle)
    return answer(a)
  }
  return undefined
}

const bridge = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/forwarding.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? process.env.BASE!,
  bridges: [{ handle: 'dir', keyPair: dirKey, decide: () => ({ status: 'prepared' }), serve, headers: ['authorization', 'x-forwarded-authorization', 'x-ledger'] }],
})

await step('bridge.create dir', () =>
  // The ledger calls `{server}/v2/anchors…` (recorded), unlike entries (`{server}/credits`).
  s.bridge.init().data({ handle: 'dir', schema: 'rest', config: { server: BRIDGE_URL.replace(/\/v2$/, '') }, secure: [], access: mine }).hash().sign([{ keyPair }]).send(),
)
await step('signer.create dir', () => s.signer.init().data({ handle: 'dir', public: dirKey.public, format: 'ed25519-raw' }).hash().sign([{ keyPair }]).send())
await create('wallet', { handle: 'alice' })

const aspect = (action: string, strategy?: string, bridge = 'dir') => ({ schema: 'aspect', action, invoke: { bridge }, ...(strategy ? { config: { strategy } } : {}) })
const policy = (handle: string, values: unknown[]) =>
  step(`policy.create ${handle}`, () => s.policy.init().data({ handle, schema: 'processing', record: 'anchor', values, access: mine }).hash().sign([{ keyPair }]).send())

// Validation: strategies an action may not use, a bridge that does not exist, an aspect without invoke.
await policy('v-read-validate', [aspect('read', 'validate')])
await policy('v-create-fallback', [aspect('create', 'fallback')])
await policy('v-drop-synchronize', [aspect('drop', 'synchronize')])
await policy('v-query-synchronize', [aspect('query', 'synchronize')])
await policy('v-unknown-strategy', [aspect('create', 'mirror')])
await policy('v-unknown-action', [aspect('frobnicate', 'proxy')])
await policy('v-unknown-bridge', [aspect('create', 'proxy', 'ghost')])
await policy('v-no-invoke', [{ schema: 'aspect', action: 'create' }])

const make = (handle: string, name = `anchor.create ${handle}`) =>
  step(name, () => s.anchor.init().data({ handle, wallet: 'alice', target: 'alice', access: mine }).hash().sign([{ keyPair }]).send())
const read = (handle: string, name = `anchor.read ${handle}`) => step(name, () => s.anchor.read(handle))
const current = async (handle: string) => {
  try {
    return (await s.anchor.read(handle)).response.data
  } catch {
    return undefined
  }
}
const update = (handle: string, name: string) =>
  step(name, async () => s.anchor.from(await current(handle)).data({ custom: { name: handle } }).hash().sign([{ keyPair }]).send())
const sign = (handle: string, name: string) =>
  step(name, async () => s.anchor.from(await current(handle)).sign([{ keyPair, custom: { status: 'inactive' } }]).send())
const drop = (handle: string, name: string) => step(name, () => s.anchor.drop(handle).hash().sign([{ keyPair }]).send())

// Three of those are accepted, and in force whatever their status: a create goes to the
// bridge that does not exist. Dropped, so they do not match later.
await make('ghost-0', 'anchor.create ghost-0 (policy names no bridge)')
for (const h of ['v-unknown-bridge', 'v-drop-synchronize', 'v-query-synchronize'])
  await step(`policy.drop ${h}`, () => s.policy.drop(h).hash().sign([{ keyPair }]).send())

// A local anchor before any forwarding.
await make('local-0', 'anchor.create local-0 (no policy)')

const all = (w: string, r: string) => ['create', 'update', 'sign', 'drop'].map((a) => aspect(a, w)).concat(['read', 'query'].map((a) => aspect(a, r)))
await policy('fwd', all('proxy', 'proxy'))
await step('policy.read fwd', () => s.policy.read('fwd'))

// proxy: everything goes to the directory, nothing is kept.
await make('dir-1', 'proxy create dir-1')
await make('dir-2', 'proxy create dir-2')
await read('dir-1', 'proxy read dir-1')
await read('local-0', 'proxy read local-0 (only local)')
await read('nowhere', 'proxy read nowhere')
await step('proxy list', () => s.anchor.list())
await update('dir-1', 'proxy update dir-1')
await sign('dir-1', 'proxy sign dir-1')
await make('bad-shape', 'proxy create bad-shape (bridge answers no record)')
await make('bad-proof', 'proxy create bad-proof (bridge hash wrong)')
await make('unauthorized', 'proxy create unauthorized (bridge 401)')
await make('refused-1', 'proxy create refused-1 (bridge error)')
await drop('dir-1', 'proxy drop dir-1')

// validate writes, fallback reads.
await step('policy.update fwd validate/fallback', async () =>
  s.policy.from((await s.policy.read('fwd')).response.data).data({ values: all('validate', 'fallback') }).hash().sign([{ keyPair }]).send(),
)
await make('loc-1', 'validate create loc-1')
await read('loc-1', 'fallback read loc-1 (local)')
await read('dir-2', 'fallback read dir-2 (directory only)')
await read('nowhere', 'fallback read nowhere')
await step('fallback list', () => s.anchor.list())
await make('loc-1', 'validate create loc-1 again (duplicate)')
await make('refused-2', 'validate create refused-2 (bridge error)')
await read('refused-2', 'fallback read refused-2')
await update('loc-1', 'validate update loc-1')
await sign('loc-1', 'validate sign loc-1')
await drop('loc-1', 'validate drop loc-1')
await read('loc-1', 'fallback read loc-1 after drop')

// synchronize: kept locally, then updated with what the directory answered.
await step('policy.update fwd synchronize', async () =>
  s.policy
    .from((await s.policy.read('fwd')).response.data)
    // Six values as before: the SDK merges arrays by index, and two `read` values would be refused.
    .data({ values: ['create', 'update', 'sign'].map((a) => aspect(a, 'synchronize')).concat([aspect('drop', 'validate'), aspect('read', 'fallback'), aspect('query', 'fallback')]) })
    .hash()
    .sign([{ keyPair }])
    .send(),
)
await make('syn-1', 'synchronize create syn-1')
await make('syn-mut', 'synchronize create syn-mut (directory changes data)')
await read('syn-mut', 'read syn-mut')
await update('syn-1', 'synchronize update syn-1')
await sign('syn-1', 'synchronize sign syn-1')
await step('anchor.list data.handle=syn-1', () => s.anchor.list({ 'data.handle': 'syn-1' }))

// Two policies with a value for the same action.
await policy('twin', [aspect('read', 'proxy')])
await read('syn-1', 'read syn-1 (two policies say read)')

await new Promise((r) => setTimeout(r, 1000))
await bridge.close()
