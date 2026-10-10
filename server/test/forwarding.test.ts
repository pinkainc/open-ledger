// Anchor forwarding by processing policies (recorded in forwarding): a bridge that keeps
// anchors as a directory, and what the ledger makes of its answers per strategy.
import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { generateKeyPair, hashData, serverProof } from '../src/crypto.js'
import { STORES, failure, newKeyPair, newLedger, startServer, testBridge, type Call, type KeyPair } from './helpers.js'

type Reply = { status: number; body?: unknown }

for (const [storeName, makeStore] of STORES) {
  describe(`anchor forwarding on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let bridge: Awaited<ReturnType<typeof testBridge>>
    let kp: KeyPair
    const dirKey = generateKeyPair()
    // The directory: anchors by handle, as last sent. `odd` answers a call instead.
    let kept: Map<string, any>
    let odd: (c: Call) => Reply | undefined
    const signed = (r: any) => {
      const hash = hashData(r.data)
      return { hash, data: r.data, ...(r.luid ? { luid: r.luid } : {}), meta: { proofs: [...(r.meta?.proofs ?? []), serverProof(hash, { moment: new Date().toISOString() }, dirKey, 'dir')] } }
    }
    function directory(c: Call): Reply {
      const m = c.url.match(/^\/v2\/anchors(?:\/([^/]+))?(\/proofs)?$/)
      if (!m) return { status: 404 }
      const id = m[1] && decodeURIComponent(m[1])
      if (c.method === 'POST' && !id) {
        const a = { data: c.body.data, meta: { proofs: c.body.meta.proofs }, luid: c.body.luid }
        kept.set(a.data.handle, a)
        return { status: 201, body: signed(a) }
      }
      if (c.method === 'GET' && !id) return { status: 200, body: signed({ data: [...kept.values()].map((a) => ({ hash: hashData(a.data), ...a })) }) }
      const a = kept.get(id!)
      if (!a) return { status: 404, body: signed({ data: { reason: 'record.not-found', detail: `Anchor ${id} is not in the directory` } }) }
      if (c.method === 'PUT') Object.assign(a, { data: c.body.data, meta: { proofs: c.body.meta.proofs } })
      if (c.method === 'POST') a.meta.proofs.push(c.body)
      if (c.method === 'DELETE') kept.delete(id!)
      return { status: 200, body: signed(a) }
    }
    // The test bridge asks for the status, then the body, of the same call: answer once.
    const replyTo = (c: Call): Reply => ((c as any).reply ??= odd(c) ?? directory(c))

    before(async () => {
      server = await startServer(await makeStore())
      bridge = await testBridge()
      bridge.answerWith((c) => replyTo(c).status)
      bridge.replyWith((c) => replyTo(c).body)
      kp = await newKeyPair()
    })
    after(async () => {
      await server.close()
      await bridge.close()
    })
    beforeEach(() => {
      kept = new Map()
      odd = () => undefined
      bridge.calls.length = 0
    })

    const raw = async (p: Promise<any>) => (await p).response.data
    const aspect = (action: string, strategy?: string, b = 'dir') => ({ schema: 'aspect', action, invoke: { bridge: b }, ...(strategy ? { config: { strategy } } : {}) })
    const every = (w: string, r: string) => ['create', 'update', 'sign', 'drop'].map((a) => aspect(a, w)).concat(['read', 'query'].map((a) => aspect(a, r)))

    async function books(values: unknown[] = []) {
      const { sdk, handle } = await newLedger(server.base, kp)
      const s: any = sdk
      const send = (x: any) => raw(x.hash().sign([{ keyPair: kp }]).send())
      await send(s.bridge.init().data({ handle: 'dir', schema: 'rest', config: { server: bridge.url.replace(/\/v2$/, '') }, secure: [] }))
      await send(s.wallet.init().data({ handle: 'alice' }))
      const policy = (h: string, vs: unknown[]) => send(s.policy.init().data({ handle: h, schema: 'processing', record: 'anchor', values: vs }))
      if (values.length) await policy('fwd', values)
      const anchor = (h: string) => send(s.anchor.init().data({ handle: h, wallet: 'alice', target: 'alice' }))
      const read = (h: string) => raw(s.anchor.read(h))
      return { s, ledger: handle, send, policy, anchor, read }
    }
    const systemProofs = (r: any) => r.meta.proofs.filter((p: any) => p.signer === 'system').map((p: any) => p.custom)

    test('a processing policy is checked against the spec, then for strategies its actions may not use', async () => {
      const { policy, anchor } = await books()
      const read = await failure(policy('a', [aspect('read', 'validate')]))
      assert.deepEqual([read.status, read.reason, read.detail], [422, 'record.schema-invalid', "Cannot define 'validate' strategy for read or query actions"])
      assert.equal((await failure(policy('b', [aspect('create', 'fallback')]))).detail, "Cannot define 'fallback' strategy for non-read or query actions")
      const errs = (await failure(policy('c', [aspect('create', 'mirror')]))).body.data.custom.errors
      assert.equal(errs.length, 10)
      assert.deepEqual(errs[5], { path: '/body/data/values/0/config/strategy', message: 'must be equal to one of the allowed values: proxy, fallback, validate, synchronize', errorCode: 'enum.openapi.validation' })
      assert.deepEqual(errs.at(-1), { path: '/body/data', message: 'must match a schema in anyOf', errorCode: 'anyOf.openapi.validation' })
      const bare = await failure(policy('d', [{ schema: 'aspect', action: 'create' }]))
      assert.equal(bare.body.data.custom.errors[5].path, '/body/data/values/0/invoke')
      assert.match(bare.detail, /request\/body\/data\/values\/0 must have required property 'invoke'/)
      // A bridge that does not exist is accepted, and fails at use.
      await policy('e', [aspect('create', 'proxy', 'ghost')])
      const ghost = await failure(anchor('g'))
      assert.deepEqual([ghost.status, ghost.reason, ghost.detail], [500, 'forward.unexpected-error', "Forward bridge 'ghost' configured but not exists"])
      assert.equal(bridge.calls.length, 0)
    })

    test('proxy: the bridge answers for every action with the ledger token, nothing is kept', async () => {
      const { s, ledger, send, anchor, read } = await books(every('proxy', 'proxy'))
      const a = await anchor('dir-1')
      const [call] = bridge.calls
      assert.deepEqual([call.method, call.url], ['POST', '/v2/anchors'])
      const token = String(call.headers.authorization).replace(/^Bearer /, '')
      const claims = decodeJwt(token)
      assert.deepEqual([claims.iss, claims.sub, claims.aud, Number(claims.exp) - Number(claims.iat)], [`ledger:${ledger}`, `system@${ledger}`, 'dir', 86400])
      assert.equal(decodeProtectedHeader(token).alg, 'EdDSA')
      assert.match(String(call.headers['x-forwarded-authorization']), /^Bearer /)
      // The ledger's proof says `created`, the answer is the bridge's own.
      assert.deepEqual(systemProofs(call.body).map((c: any) => c.status), ['created'])
      assert.match(call.body.luid, /^\$anc\./)
      assert.equal(a.luid, call.body.luid)
      assert.equal(a.meta.proofs.at(-1).signer, 'dir')
      assert.equal((await read('dir-1')).meta.proofs.at(-1).signer, 'dir')
      const listed = await raw(s.anchor.list())
      assert.deepEqual(listed.data.map((r: any) => r.data.handle), ['dir-1'])
      assert.deepEqual(listed.meta.proofs.map((p: any) => p.signer), ['dir', 'system'])
      const v2 = await send(s.anchor.from(await read('dir-1')).data({ custom: { n: 1 } }))
      assert.deepEqual(v2.data.custom, { n: 1 })
      const signedOnce = await raw(s.anchor.from(await read('dir-1')).sign([{ keyPair: kp, custom: { status: 'inactive' } }]).send())
      assert.equal(signedOnce.meta.proofs.at(-2).custom.status, 'inactive')
      await raw(s.anchor.drop('dir-1').hash().sign([{ keyPair: kp }]).send())
      assert.equal(kept.size, 0)
      const drop = bridge.calls.at(-1)!
      assert.deepEqual([drop.method, systemProofs(drop.body).at(-1).status], ['DELETE', 'dropped'])
      // A bridge error comes back signed by the bridge, then the ledger, naming the cause.
      const gone = await failure(read('dir-1'))
      assert.deepEqual([gone.status, gone.reason, gone.detail], [404, 'record.not-found', 'Anchor dir-1 is not in the directory'])
      assert.deepEqual(gone.body.meta.proofs.map((p: any) => p.signer), ['dir', 'system'])
      assert.deepEqual(gone.body.meta.proofs[1].custom.causedBy, { detail: 'Error derived from anchor forwarding response' })
    })

    test('answers the ledger cannot use: no record, a wrong hash, a 401, data the bridge changed', async () => {
      const { anchor } = await books(every('proxy', 'proxy'))
      odd = (c) => (c.body?.data?.handle === 'shape' ? { status: 400, body: { error: 'no' } } : undefined)
      assert.deepEqual(Object.values(await failure(anchor('shape'))).slice(0, 3), [502, 'forward.invalid-response', 'Invalid response from bridge dir'])
      odd = (c) => (c.body?.data?.handle === 'hash' ? { status: 201, body: { hash: '0'.repeat(64), data: c.body.data, meta: { proofs: [] } } } : undefined)
      assert.deepEqual(Object.values(await failure(anchor('hash'))).slice(0, 3), [422, 'crypto.hash-invalid', `Invalid dto hash: ${'0'.repeat(64)}`])
      odd = (c) => (c.body?.data?.handle === 'who' ? { status: 401, body: signed({ data: { reason: 'auth.unauthorized', detail: 'no' } }) } : undefined)
      assert.deepEqual(Object.values(await failure(anchor('who'))).slice(0, 3), [500, 'forward.unexpected-error', 'Unexpected error while forwarding request to bridge'])
      odd = (c) => (c.body?.data?.handle === 'mut' ? { status: 201, body: signed({ ...c.body, data: { ...c.body.data, custom: { x: 1 } } }) } : undefined)
      const mut = await failure(anchor('mut'))
      assert.deepEqual([mut.status, mut.reason], [422, 'crypto.signature-invalid'])
      odd = (c) => (c.body?.data?.handle === 'taken' ? { status: 422, body: signed({ data: { reason: 'record.duplicated', detail: 'taken', custom: { by: 'x' } } }) } : undefined)
      const taken = await failure(anchor('taken'))
      assert.deepEqual([taken.status, taken.reason, taken.body.data.custom], [422, 'record.duplicated', { by: 'x' }])
    })

    test('validate and fallback: the bridge accepts first, the ledger keeps its own record', async () => {
      const { s, send, anchor, read } = await books(every('validate', 'fallback'))
      const a = await anchor('loc-1')
      const sent = bridge.calls[0].body
      assert.notEqual(sent.luid, a.luid)
      assert.deepEqual(a.meta.proofs.map((p: any) => p.signer ?? 'client'), ['client', 'system'])
      bridge.calls.length = 0
      assert.equal((await read('loc-1')).luid, a.luid)
      assert.equal(bridge.calls.length, 0, 'a local record is read without a call')
      const dup = await failure(anchor('loc-1'))
      assert.deepEqual([dup.status, dup.detail, bridge.calls.length], [409, 'Anchor with handle loc-1 already exists.', 0])
      // Refused by the bridge: nothing kept, a later read asks the bridge.
      odd = (c) => (c.body?.data?.handle === 'no' ? { status: 422, body: signed({ data: { reason: 'record.duplicated', detail: 'taken' } }) } : undefined)
      assert.equal((await failure(anchor('no'))).status, 422)
      assert.equal((await failure(read('no'))).detail, 'Anchor no is not in the directory')
      kept.set('far', { data: { handle: 'far', wallet: 'alice', target: 'alice' }, meta: { proofs: [] } })
      assert.equal((await read('far')).meta.proofs.at(-1).signer, 'dir')
      const v2 = await send(s.anchor.from(await read('loc-1')).data({ custom: { n: 2 } }))
      assert.equal(v2.luid, a.luid)
      assert.equal(bridge.calls.at(-1)!.method, 'PUT')
      const inactive = await raw(s.anchor.from(v2).sign([{ keyPair: kp, custom: { status: 'inactive' } }]).send())
      assert.equal(inactive.meta.status, 'inactive')
      assert.equal(bridge.calls.at(-1)!.url, '/v2/anchors/loc-1/proofs')
      // The list is the ledger's while it has anchors.
      const calls = bridge.calls.length
      assert.deepEqual((await raw(s.anchor.list())).data.map((r: any) => r.data.handle), ['loc-1'])
      assert.equal(bridge.calls.length, calls)
      await raw(s.anchor.drop('loc-1').hash().sign([{ keyPair: kp }]).send())
      assert.equal(bridge.calls.at(-1)!.method, 'DELETE')
      assert.equal((await raw(s.anchor.list())).data.length, 1, 'with none, the bridge lists its own')
    })

    test('synchronize: the ledger keeps what the bridge answered', async () => {
      const { s, send, anchor, read } = await books(['create', 'update', 'sign'].map((a) => aspect(a, 'synchronize')).concat([aspect('drop', 'validate'), aspect('read', 'fallback'), aspect('query', 'fallback')]))
      const a = await anchor('syn-1')
      const sent = bridge.calls[0].body
      assert.equal(sent.meta.status, 'created')
      assert.deepEqual(systemProofs(sent).map((c: any) => Object.keys(c).sort().join()), ['luid,moment,status', 'moment,status'])
      assert.notEqual(a.luid, sent.luid)
      assert.deepEqual(a.meta.proofs.map((p: any) => p.signer ?? 'client'), ['client', 'system', 'system', 'dir'])
      assert.deepEqual((await read('syn-1')).meta.proofs, a.meta.proofs)
      const v2 = await send(s.anchor.from(a).data({ custom: { n: 3 } }))
      assert.deepEqual([v2.luid, v2.meta.proofs.at(-1).signer], [a.luid, 'dir'])
      // Data the bridge changed breaks the client's proof: nothing is kept.
      odd = (c) => (c.body?.data?.handle === 'mut' ? { status: 201, body: signed({ ...c.body, data: { ...c.body.data, custom: { x: 1 } } }) } : undefined)
      assert.equal((await failure(anchor('mut'))).reason, 'crypto.signature-invalid')
      assert.deepEqual((await raw(s.anchor.list())).data.map((r: any) => r.data.handle), ['syn-1'])
    })

    test('two values for one action fail at use, whatever their policies status', async () => {
      const { policy, read, anchor } = await books([aspect('read', 'proxy')])
      await anchor('x')
      await policy('twin', [aspect('read', 'fallback')])
      const twin = await failure(read('x'))
      assert.deepEqual([twin.status, twin.reason, twin.detail], [500, 'forward.unexpected-error', 'Multiple processing aspect values found for action read.'])
    })
  })
}
