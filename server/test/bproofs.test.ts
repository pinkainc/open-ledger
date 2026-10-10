// Who may add a proof to an intent (recorded, bproofs): `create` on `intent-proof`,
// from the ledger's rules; `record: intent` is not enough, and `sign` is no action.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STORES, failure, newKeyPair, newLedger, sdkFor, settle, startServer, type KeyPair } from './helpers.js'

for (const [storeName, makeStore] of STORES) {
  describe(`intent proofs on ${storeName}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>
    let op: KeyPair, bank: KeyPair
    before(async () => {
      server = await startServer(await makeStore())
      op = await newKeyPair()
      bank = await newKeyPair()
    })
    after(() => server.close())

    async function books(extra: unknown[]) {
      const { handle, sdk } = await newLedger(server.base, op, [
        { action: 'any', signer: { public: op.public } },
        { action: 'any', record: 'any', signer: { public: op.public } },
        { action: 'access' },
        { action: 'read', record: 'any' },
        ...extra,
      ])
      const s: any = sdk
      await s.symbol.init().data({ handle: 'usd', factor: 100 }).hash().sign([{ keyPair: op }]).send()
      await s.wallet.init().data({ handle: 'alice' }).hash().sign([{ keyPair: op }]).send()
      await s.intent.init().data({ handle: 'i', claims: [{ action: 'issue', target: { handle: 'alice' }, symbol: { handle: 'usd' }, amount: 1 }] }).hash().sign([{ keyPair: op }]).send()
      await settle(s, 'i')
      const intent = (await s.intent.read('i')).response.data
      const asBank: any = sdkFor(server.base, handle, bank)
      return () => asBank.intent.from(intent).sign([{ keyPair: bank, custom: { moment: new Date().toISOString() } }]).send()
    }

    test('record: intent does not grant a proof; each rule missed by its signer is listed', async () => {
      const prove = await books([{ action: 'any', record: 'intent', signer: { public: bank.public } }])
      const f = await failure(prove())
      assert.equal(f.status, 403)
      assert.equal(f.detail, 'Missing permissions')
      // two always, plus the operator's `{any, record: any}`
      assert.equal(f.body.data.custom.errors.length, 3)
    })

    test('{create, record: intent-proof} grants it', async () => {
      const prove = await books([{ action: 'create', record: 'intent-proof', signer: { public: bank.public } }])
      await prove()
    })

    test('sign is no access action', async () => {
      const { sdk } = await newLedger(server.base, op)
      const f = await failure((sdk as any).wallet.init().data({ handle: 'w', access: [{ action: 'sign', record: 'intent' }] }).hash().sign([{ keyPair: op }]).send())
      assert.equal(f.status, 422)
      assert.equal(f.reason, 'record.schema-invalid')
      assert.match(f.detail, /access\/0\/action must be equal to one of the allowed values/)
    })
  })
}
