// Bridges, second pass (recorded in `secure`): `secure` rules and their secrets, the
// retry cap, traits.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { Core } from '../src/core.js'
import { SecretBox } from '../src/secrets.js'
import { MemoryStore } from '../src/store.js'
import { STORES, balanceOf, failure, newKeyPair, newLedger, ref, sdkFor, settle, startServer, until, type KeyPair } from './helpers.js'

test('a sealed secret opens only with its key and its context', () => {
  const box = new SecretBox(Buffer.alloc(32, 7).toString('base64'))
  const sealed = box.seal('key-123', 'l/bridge/b/apiKey')
  assert.ok(!sealed.includes('key-123'))
  assert.equal(box.open(sealed, 'l/bridge/b/apiKey'), 'key-123')
  assert.throws(() => box.open(sealed, 'l/bridge/other/apiKey'))
  assert.throws(() => new SecretBox(Buffer.alloc(32, 8).toString('base64')).open(sealed, 'l/bridge/b/apiKey'))
})

// A bridge that records each call with its headers, answers `status()`, and serves an
// OAuth2 token endpoint.
async function bridgeServer() {
  const calls: { method: string; url: string; headers: IncomingHttpHeaders; body: any }[] = []
  let status = () => 202
  const server = createServer((req, res) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => {
      calls.push({ method: req.method!, url: req.url!, headers: req.headers, body: s })
      if (req.url === '/oauth/token') {
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
      }
      res.statusCode = req.method === 'PUT' ? 200 : status()
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  return { base, url: `${base}/v2`, calls, answer: (f: () => number) => (status = f), close: () => new Promise<void>((r) => server.close(() => r())) }
}

for (const [storeName, makeStore] of STORES) {
  describe(`bridge security and delivery limits on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let b: Awaited<ReturnType<typeof bridgeServer>>
    let kp: KeyPair, kb: KeyPair
    let store: Awaited<ReturnType<(typeof STORES)[number][1]>>
    before(async () => {
      store = await makeStore()
      server = await startServer(store, new Core(store, { bridges: { retryMs: 10, maxRetries: 5 } }))
      b = await bridgeServer()
      kp = await newKeyPair()
      kb = await newKeyPair()
    })
    after(async () => {
      await server.close()
      await b.close()
    })

    const raw = async (p: Promise<any>) => (await p).response.data
    let seq = 0
    const sign = () => [{ keyPair: kp }]
    const bridgeData = (handle: string, extra: Record<string, unknown> = {}) => ({ handle, schema: 'rest', config: { server: b.url }, secure: [], ...extra })

    async function books(bridge: Record<string, unknown>, secret?: Record<string, string>) {
      const { handle, sdk } = await newLedger(server.base, kp)
      const s: any = sdk
      await s.bridge.init().data(bridge).meta({ proofs: [], ...(secret ? { secret } : {}) }).hash().sign(sign()).send()
      await s.signer.init().data({ handle: bridge.handle, public: kb.public, format: 'ed25519-raw' }).hash().sign(sign()).send()
      await s.symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign(sign()).send()
      await s.wallet.init().data({ handle: 'alice' }).hash().sign(sign()).send()
      await s.wallet.init().data({ handle: 'acct', bridge: bridge.handle }).hash().sign(sign()).send()
      await settle(s, await send(s, [{ action: 'issue', target: ref('alice'), symbol: ref('usd'), amount: 1000 }]))
      return { ledger: handle, sdk: s, asBank: sdkFor(server.base, handle, kb) as any }
    }
    async function send(sdk: any, claims: unknown[]) {
      const h = `s-${++seq}`
      await sdk.intent.init().data({ handle: h, claims }).hash().sign(sign()).send()
      return h
    }
    const t = (from: string, to: string, amount: number) => ({ action: 'transfer', source: ref(from), target: ref(to), symbol: ref('usd'), amount })
    const of = (h: string) => b.calls.filter((c) => c.body.includes(`"${h}"`))
    // Reports what the bridge is asked to, until the intent is final.
    async function run(sdk: any, asBank: any, h: string) {
      const done = new Set<string>()
      for (;;) {
        const i = await raw(sdk.intent.read(h))
        if (['completed', 'rejected'].includes(i.meta.status)) return i
        for (const c of of(h).filter((c) => c.method === 'POST' && !done.has(c.url))) {
          const entry = JSON.parse(c.body).data
          const status = c.url.endsWith('/commit') ? 'committed' : c.url.endsWith('/abort') ? 'aborted' : 'prepared'
          done.add(c.url)
          await raw(asBank.intent.from(entry.intent).sign([{ keyPair: kb, custom: { handle: entry.handle, status } }]).send())
        }
        await new Promise((r) => setTimeout(r, 10))
      }
    }

    test('header rules carry their secrets; the record and its changes never do', async () => {
      const secure = [
        { schema: 'header', key: 'X-API-Key', value: '{{ secret.apiKey }}' },
        { schema: 'header', key: 'X-Static', value: '{{ secret.static }}' },
      ]
      const { ledger, sdk, asBank } = await books(bridgeData('hdr', { secure }), { apiKey: 'key-123', static: 'static-456' })
      const h = await send(sdk, [t('alice', 'acct', 1)])
      assert.equal((await run(sdk, asBank, h)).meta.status, 'completed')
      for (const c of of(h)) assert.deepEqual([c.headers['x-api-key'], c.headers['x-static']], ['key-123', 'static-456'], c.url)
      const record = await raw(sdk.bridge.read('hdr'))
      assert.deepEqual(record.data.secure, secure)
      assert.equal(record.meta.secret, undefined)
      assert.ok(!JSON.stringify(await raw(sdk.bridge.read('hdr'))).includes('key-123'))
      const sealed = await store.getSecret(ledger, 'bridge/hdr/apiKey')
      assert.ok(sealed && !sealed.includes('key-123'), 'stored sealed')
    })

    test('a reference needs its value, once; a plain value is refused by the schema', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const s: any = sdk
      const missing = await failure(s.bridge.init().data(bridgeData('nosecret', { secure: [{ schema: 'header', key: 'X-API-Key', value: '{{ secret.missing }}' }] })).hash().sign(sign()).send())
      assert.deepEqual([missing.status, missing.reason, missing.detail], [422, 'record.invalid', "Record data has a secret reference to new secret 'missing' but no secret value was provided in 'meta.secret.missing'"])
      const plain = await failure(s.bridge.init().data(bridgeData('plain', { secure: [{ schema: 'header', key: 'X-API-Key', value: 'plain-value' }] })).hash().sign(sign()).send())
      assert.equal(plain.reason, 'record.schema-invalid')
      assert.deepEqual(
        plain.body.data.custom.errors.map((e: any) => e.path),
        ['/body/data/secure/0/clientId', '/body/data/secure/0/value', '/body/data/secure/0/public', '/body/data/secure/0'],
      )
      // An update may keep an earlier secret without sending it again.
      await s.bridge.init().data(bridgeData('kept', { secure: [{ schema: 'header', key: 'K', value: '{{ secret.k }}' }] })).meta({ proofs: [], secret: { k: 'v' } }).hash().sign(sign()).send()
      const current = await raw(s.bridge.read('kept'))
      await s.bridge.from(current).data({ ...current.data, config: { server: `${b.url}` }, custom: { note: 'x' } }).hash().sign(sign()).send()
    })

    test('oauth2: a token from the endpoint, Basic client credentials, kept while it lives', async () => {
      const secure = [{ schema: 'oauth2', clientId: 'client-1', clientSecret: '{{ secret.oauth }}', tokenUrl: `${b.base}/oauth/token`, scope: 'ledger' }]
      const { sdk, asBank } = await books(bridgeData('oa', { secure }), { oauth: 'client-secret-789' })
      const before = b.calls.filter((c) => c.url === '/oauth/token').length
      const h = await send(sdk, [t('alice', 'acct', 2)])
      assert.equal((await run(sdk, asBank, h)).meta.status, 'completed')
      await until(() => of(h).filter((c) => c.method === 'PUT').length === 2, 'status notifications')
      const tokens = b.calls.filter((c) => c.url === '/oauth/token').slice(before)
      // `expires_in: 3600`: one request serves every call (the reference asks each time).
      assert.ok(of(h).length > 1)
      assert.equal(tokens.length, 1)
      assert.equal(tokens[0].headers.authorization, `Basic ${Buffer.from('client-1:client-secret-789').toString('base64')}`)
      assert.equal(tokens[0].body, 'grant_type=client_credentials&scope=ledger')
      for (const c of of(h)) assert.equal(c.headers.authorization, 'Bearer tok')
    })

    test('a bridge that keeps failing: six attempts, then cancelled; activate sends it again', async () => {
      const { sdk, asBank } = await books(bridgeData('down'))
      b.answer(() => 500)
      const h = await send(sdk, [t('alice', 'acct', 4)])
      const events = sdk.bridge.with('down').events
      const d = await until(async () => (await raw(events.list({ 'data.linked': h }))).data.find((d: any) => d.meta.status === 'cancelled'), 'cancelled')
      const proofs = d.meta.proofs.map((p: any) => p.custom)
      assert.equal(d.meta.replay, 6)
      assert.deepEqual(proofs.map((c: any) => c.status), ['failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'cancelled'])
      assert.deepEqual(proofs.at(-2).detail, { httpStatus: 500, body: '{}' }, 'the last failure carries the answer')
      assert.equal(proofs[0].detail.body, undefined)
      assert.equal(proofs.at(-1).reason, 'delivery.retry-cap-exhausted')
      const intent = await raw(sdk.intent.read(h))
      assert.deepEqual(intent.meta.proofs.at(-1).custom.reason, 'core.bridge-unreachable')
      b.answer(() => 202)
      await sdk.bridge.with('down').activate({ maxAge: 0 }).hash().sign(sign()).send()
      assert.equal((await run(sdk, asBank, h)).meta.status, 'completed')
    })

    test('traits: no statuses, no notifications; a filtered credit is the ledger’s own', async () => {
      const { sdk, asBank } = await books(bridgeData('tr', { traits: ['debits', { method: 'credits', filter: { amount: { $gte: 100 } } }] }))
      const small = await send(sdk, [t('alice', 'acct', 5)])
      assert.equal((await settle(sdk, small)).meta.status, 'completed')
      assert.deepEqual(of(small), [], 'the bridge heard nothing')
      const big = await send(sdk, [t('alice', 'acct', 150)])
      assert.equal((await run(sdk, asBank, big)).meta.status, 'completed')
      assert.deepEqual(of(big).map((c) => c.method), ['POST', 'POST'], 'prepare and commit, no PUT')
      assert.deepEqual(await balanceOf(sdk, 'acct'), { available: 155, reserved: 0 })
    })
  })
}

test('a server without a master key seals with a key of its own', () => {
  const store = new MemoryStore()
  const core = new Core(store)
  assert.equal(core.secrets.ephemeral, !process.env.OPEN_LEDGER_MASTER_KEY)
  core.close()
})
