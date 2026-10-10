// User schemas (recorded in uschema): a record is validated against the schema it
// names, and must name one once a schema for its kind exists.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STORES, balanceOf, failure, newKeyPair, newLedger, ref, settle, startServer, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`user schemas on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let kp: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      kp = await newKeyPair()
    })
    after(() => server.close())

    const raw = async (p: Promise<any>) => (await p).response.data
    const make = (sdk: any, client: string, data: Record<string, unknown>) => raw(sdk[client].init().data(data).hash().sign([{ keyPair: kp }]).send())
    const schema = (sdk: any, handle: string, record: string, content: unknown) => make(sdk, 'schema', { handle, record, format: 'json-schema', schema: content })
    const kind = { type: 'object', required: ['custom'], properties: { custom: { type: 'object', required: ['kind'], properties: { kind: { enum: ['person', 'company'] } } } } }

    test('without schemas of its kind a record names none', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await schema(sdk, 'w', 'wallet', kind)
      assert.equal((await make(sdk, 'symbol', { handle: 'usd', factor: 100 })).data.handle, 'usd')
    })

    test('once a schema of its kind exists, a record must name one — on create and on update', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const early = await make(sdk, 'wallet', { handle: 'early' })
      await schema(sdk, 'w', 'wallet', kind)
      const f = await failure(make(sdk, 'wallet', { handle: 'late' }))
      assert.deepEqual([f.status, f.reason, f.detail], [422, 'record.schema-invalid', 'There are schemas defined for record of type wallet, you must specify at least one.'])
      const u = await failure(raw(sdk.wallet.from(early).data({ custom: { kind: 'person' } } as any).hash().sign([{ keyPair: kp }]).send()))
      assert.equal(u.reason, 'record.schema-invalid')
      const ok = await raw(sdk.wallet.from(early).data({ schema: 'w', custom: { kind: 'person' } } as any).hash().sign([{ keyPair: kp }]).send())
      assert.equal(ok.data.schema, 'w')
    })

    test('a missing schema, or one of another kind, is a missing relation', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await schema(sdk, 's', 'symbol', { type: 'object' })
      for (const name of ['nope', 's']) {
        const f = await failure(make(sdk, 'wallet', { handle: 'x', schema: name }))
        assert.deepEqual([f.reason, f.detail], ['record.relation-not-found', `Schema ${name} not found for record of type wallet.`])
      }
    })

    test('data is validated with every error, paths written with dots', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await schema(sdk, 'w', 'wallet', { ...kind, properties: { ...kind.properties, handle: { maxLength: 3 } } })
      const f = await failure(make(sdk, 'wallet', { handle: 'toolong', schema: 'w', custom: { kind: 'robot' } }))
      assert.equal(f.detail, 'Schema validator error: data.custom.kind must be equal to one of the allowed values, data.handle must NOT have more than 3 characters')
      assert.deepEqual(
        f.body.data.custom.errors.map((e: any) => [e.instancePath, e.keyword]),
        [['/custom/kind', 'enum'], ['/handle', 'maxLength']],
      )
      assert.equal((await make(sdk, 'wallet', { handle: 'ann', schema: 'w', custom: { kind: 'person' } })).data.handle, 'ann')
    })

    test('a schema update applies to the next record', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const v1 = await schema(sdk, 'w', 'wallet', { type: 'object' })
      await make(sdk, 'wallet', { handle: 'a', schema: 'w' })
      await raw(sdk.schema.from(v1).data({ schema: { type: 'object', required: ['custom'] } }).hash().sign([{ keyPair: kp }]).send())
      assert.equal((await failure(make(sdk, 'wallet', { handle: 'b', schema: 'w' }))).detail, "Schema validator error: data must have required property 'custom'")
    })

    test('schema content must be valid JSON Schema; format and record are enumerated', async () => {
      const { sdk } = await newLedger(server.base, kp)
      const bad = await failure(schema(sdk, 'b', 'wallet', { type: 'nonsense' }))
      assert.deepEqual([bad.reason, bad.detail], ['record.schema-invalid', 'Schema content is invalid'])
      assert.match(bad.body.data.custom.error.message, /^schema is invalid: data\/type must be equal to one of the allowed values/)
      assert.match((await failure(make(sdk, 'schema', { handle: 'f', record: 'wallet', format: 'yaml', schema: {} }))).detail, /data\/format must be equal to one of the allowed values: json-schema$/)
      assert.match((await failure(make(sdk, 'schema', { handle: 'r', record: 'ledger', format: 'json-schema', schema: {} }))).detail, /data\/record must be equal to one of the allowed values: anchor, /)
    })

    test('an intent is validated before it is accepted, and processed once valid', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await make(sdk, 'symbol', { handle: 'usd', factor: 100 })
      await make(sdk, 'wallet', { handle: 'w' })
      await schema(sdk, 'small', 'intent', { type: 'object', properties: { claims: { items: { properties: { amount: { maximum: 50 } } } } } })
      const issue = (amount: number) => ({ action: 'issue', target: ref('w'), symbol: ref('usd'), amount })
      assert.match((await failure(make(sdk, 'intent', { handle: 'none', claims: [issue(1)] }))).detail, /record of type intent/)
      const f = await failure(make(sdk, 'intent', { handle: 'big', schema: 'small', claims: [issue(60), issue(70)] }))
      assert.equal(f.detail, 'Schema validator error: data.claims.0.amount must be <= 50, data.claims.1.amount must be <= 50')
      await assert.rejects(sdk.intent.read('big'))
      await make(sdk, 'intent', { handle: 'ok', schema: 'small', claims: [issue(10)] })
      assert.equal((await settle(sdk, 'ok')).meta.status, 'completed')
      assert.deepEqual(await balanceOf(sdk, 'w'), { available: 10, reserved: 0 })
    })

    test('circles and signers follow the same rule', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await schema(sdk, 'c', 'circle', { type: 'object', required: ['custom'] })
      assert.equal((await failure(make(sdk, 'circle', { handle: 'ops' }))).reason, 'record.schema-invalid')
      assert.equal((await failure(make(sdk, 'circle', { handle: 'ops', schema: 'c' }))).detail, "Schema validator error: data must have required property 'custom'")
      assert.equal((await make(sdk, 'circle', { handle: 'ops', schema: 'c', custom: {} })).data.handle, 'ops')
      const other = await newKeyPair()
      assert.equal((await make(sdk, 'signer', { handle: 'o', public: other.public, format: 'ed25519-raw' })).data.handle, 'o')
    })

    // Recorded (uschema2): `extend` is kept as given and changes nothing — the parent's
    // rules are not checked, and any parent is accepted, a missing one or itself included.
    test('`extend` is stored, not applied', async () => {
      const { sdk } = await newLedger(server.base, kp)
      await schema(sdk, 'base', 'wallet', kind)
      const child = await make(sdk, 'schema', { handle: 'child', record: 'wallet', format: 'json-schema', schema: { type: 'object' }, extend: 'base' })
      assert.equal(child.data.extend, 'base')
      assert.equal((await make(sdk, 'wallet', { handle: 'w', schema: 'child' })).data.handle, 'w')
      for (const parent of ['nope', 'self']) await make(sdk, 'schema', { handle: parent === 'self' ? 'self' : 'orphan', record: 'wallet', format: 'json-schema', schema: { type: 'object' }, extend: parent })
      // A cycle (not recorded: it could loop the reference) is as harmless here.
      const base = await raw(sdk.schema.read('base'))
      await raw(sdk.schema.from(base).data({ extend: 'child' } as any).hash().sign([{ keyPair: kp }]).send())
      assert.equal((await make(sdk, 'wallet', { handle: 'w2', schema: 'child' })).data.handle, 'w2')
    })
  })
}
