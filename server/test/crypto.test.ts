// The crypto module is checked against signatures the reference ledger produced, not
// only against itself: a self-consistent but wrong scheme would pass a round trip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canonical, digestFor, generateKeyPair, hashData, serverProof, signDigest, verifyDigest } from '../src/crypto.js'

const exchanges = readFileSync(new URL('../../conformance/fixtures/l0.reference.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
const walletCreated = exchanges.find((x) => x.req.method === 'POST' && x.req.url.endsWith('/wallets') && x.res.status === 201)

test('canonical JSON sorts keys at every depth', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}')
})

test('record hash matches the reference ledger', () => {
  const { hash, data } = walletCreated.res.body
  assert.equal(hashData(data), hash)
})

test('every proof on a reference record verifies with our digest and ed25519', () => {
  const { hash, meta } = walletCreated.res.body
  assert.equal(meta.proofs.length, 2)
  for (const p of meta.proofs) {
    assert.equal(digestFor(hash, p.custom), p.digest)
    assert.ok(verifyDigest(p.digest, p.public, p.result), `proof by ${p.signer ?? 'client'}`)
  }
})

test('envelope hashes (lists, errors) are hashes of their data', () => {
  for (const x of exchanges) {
    const b = x.res.body
    if (b?.page || b?.data?.reason) assert.equal(hashData(b.data), b.hash, `${x.req.method} ${x.req.url}`)
  }
})

test('sign / verify round trip, and tampering is detected', () => {
  const kp = generateKeyPair()
  const digest = digestFor(hashData({ handle: 'x' }), { moment: '2026-01-01T00:00:00.000Z' })
  const sig = signDigest(digest, kp)
  assert.ok(verifyDigest(digest, kp.public, sig))
  assert.ok(!verifyDigest(digestFor(hashData({ handle: 'y' })), kp.public, sig))
  assert.ok(!verifyDigest(digest, generateKeyPair().public, sig))
})

test('serverProof has the reference field set', () => {
  const p = serverProof('ab'.repeat(32), { moment: 'm' }, generateKeyPair(), 'system')
  assert.deepEqual(Object.keys(p).sort(), ['custom', 'digest', 'method', 'origin', 'public', 'result', 'signer'])
  assert.equal(p.method, 'ed25519-v2')
  assert.equal(p.origin, 'key-pair')
})
