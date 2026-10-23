// Labels (recorded, labels): expressions, their validation, labels policies and `unique`.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLabels, checkLabels, labelsAfter, reassign } from '../src/labels.js'
import { validateLabels } from '../src/schemas.js'
import { generateKeyPair } from '../src/crypto.js'
import { LedgerError } from '../src/errors.js'
import { MemoryStore, type StoredRecord } from '../src/store.js'

const errorsOf = (labels: unknown) => {
  try {
    validateLabels(labels, '/custom/labels')
    return undefined
  } catch (e) {
    assert.ok(e instanceof LedgerError)
    return ((e as any).custom.errors as any[]).map((x) => `${x.path} ${x.message}`)
  }
}

describe('label expressions', () => {
  test('the recorded sequence', () => {
    // Each step on the list the one before left (fixture labels, seq 1–55).
    const steps: [unknown, string[]][] = [
      [['saving-account', 'preferred'], ['active', 'saving-account', 'preferred']],
      [{ $push: 'verified' }, ['active', 'saving-account', 'preferred', 'verified']],
      [{ $push: { $each: ['a', 'b'] } }, ['active', 'saving-account', 'preferred', 'verified', 'a', 'b']],
      [{ $push: { $each: ['first'], $position: 0 } }, ['first', 'active', 'saving-account', 'preferred', 'verified', 'a', 'b']],
      [{ $push: { $each: ['z'], $position: 0, $slice: 3 } }, ['z', 'first', 'active']],
      [{ $push: { $each: ['m'], $sort: -1 } }, ['z', 'm', 'first', 'active']],
      [{ $push: { $each: ['x', 'y'], $slice: -2 } }, ['x', 'y']],
      [{ $addToSet: 'x' }, ['x', 'y']],
      [{ $addToSet: { $each: ['x', 'n', 'n'] } }, ['x', 'y', 'n', 'n']],
      [{ $pull: 'x' }, ['y', 'n', 'n']],
      [{ $push: 'y' }, ['y', 'n', 'n', 'y']],
      [{ $pull: { $in: ['y', 'zz'] } }, ['n', 'n']],
      [['p', 'q', 'r', 's'], ['n', 'n', 'p', 'q', 'r', 's']],
      [{ $pullAll: ['p', 'zz'] }, ['n', 'n', 'q', 'r', 's']],
      [{ $pop: 1 }, ['n', 'n', 'q', 'r']],
      [{ $pop: -1 }, ['n', 'q', 'r']],
      [[], ['n', 'q', 'r']],
    ]
    let list = ['active']
    for (const [expr, want] of steps) assert.deepEqual((list = applyLabels(list, expr)), want, JSON.stringify(expr))
  })

  test('absent until a proof names labels', () => {
    assert.equal(labelsAfter(undefined, [{ custom: { moment: 'x' } }, {}]), undefined)
    assert.deepEqual(labelsAfter(undefined, [{ custom: { labels: { $push: 'a' } } }]), ['a'])
  })

  test('validated in the reference order', () => {
    assert.equal(errorsOf(['a']), undefined)
    assert.equal(errorsOf({ $push: { $each: ['a'], $position: 0 } }), undefined)
    assert.deepEqual(errorsOf('solo'), ['/body/custom/labels must be object', '/body/custom/labels must be array', '/body/custom/labels must match exactly one schema in oneOf'])
    assert.deepEqual(errorsOf(null), errorsOf('solo'))
    assert.deepEqual(errorsOf([1]), ['/body/custom/labels must be object', '/body/custom/labels/0 must be string', '/body/custom/labels must match exactly one schema in oneOf'])
    assert.deepEqual(errorsOf({ $set: ['a'] }), [
      ...['$pop', '$push', '$pull', '$pullAll', '$addToSet'].map((op) => `/body/custom/labels/${op} must have required property '${op}'`),
      '/body/custom/labels must match exactly one schema in oneOf',
      '/body/custom/labels must be array',
      '/body/custom/labels must match exactly one schema in oneOf',
    ])
    // Two operators: Ajv's oneOf stops at the second that fits.
    assert.deepEqual(errorsOf({ $push: 'a', $pull: 'b' }), [
      "/body/custom/labels/$pop must have required property '$pop'",
      '/body/custom/labels must match exactly one schema in oneOf',
      '/body/custom/labels must be array',
      '/body/custom/labels must match exactly one schema in oneOf',
    ])
  })
})

describe('labels policies', () => {
  const L = 'l'
  const wallet = (handle: string, custom: Record<string, unknown>, labels?: string[]): StoredRecord => ({
    hash: handle,
    data: { handle, custom },
    luid: `$wlt.${handle}`,
    meta: { proofs: [], status: 'created', moment: 'm', owners: [], ...(labels ? { labels } : {}) },
  })
  async function ledger() {
    const store = new MemoryStore()
    await store.insert(L, 'policies', {
      hash: 'p',
      data: { handle: 'p', schema: 'labels', record: 'wallet', filter: { 'custom.kind': 'account' }, values: [{ labels: ['preferred'], unique: ['custom.owner'] }, { labels: ['saving'] }] },
      luid: '$pol.p',
      meta: { proofs: [], moment: 'm', owners: [] },
    })
    return store
  }

  test('only added labels are checked, against matching policies', async () => {
    const store = await ledger()
    const account = { kind: 'account' }
    await assert.rejects(checkLabels(store, L, 'wallet', { custom: account }, ['other'], ['other', 'gold']), (e: any) => e.reason === 'record.labels-policy-violation' && e.detail === 'Labels not allowed by policy. Forbidden labels: gold')
    assert.deepEqual(await checkLabels(store, L, 'wallet', { custom: account }, ['other', 'saving'], ['saving']), [])
    assert.deepEqual(await checkLabels(store, L, 'wallet', { custom: { kind: 'card' } }, [], ['anything']), [])
    assert.deepEqual(await checkLabels(store, L, 'symbol', { custom: account }, [], ['anything']), [])
  })

  test('a unique label moves to the record that gains it', async () => {
    const store = await ledger()
    for (const w of [wallet('a1', { kind: 'account', owner: 'o1' }, ['other', 'preferred']), wallet('a3', { kind: 'account', owner: 'o2' }, ['preferred']), wallet('a4', { kind: 'account', owner: 'o1' }, ['preferred']), wallet('c1', { kind: 'card', owner: 'o1' }, ['preferred'])])
      await store.insert(L, 'wallets', w)
    const a2 = wallet('a2', { kind: 'account', owner: 'o1' }, ['preferred'])
    const unique = await checkLabels(store, L, 'wallet', a2.data, [], ['preferred'])
    const moved = await reassign(store, L, 'wallets', a2, generateKeyPair(), unique)
    assert.deepEqual(
      moved.map(([r]) => [r.data.handle, r.meta.labels]),
      [['a1', ['other']], ['a4', undefined]],
    )
    assert.equal('labels' in moved[1][0].meta, false, 'a list left empty is gone (labels2)')
    assert.deepEqual(moved[0][1].meta.labels, ['other', 'preferred'], 'the version before')
    const proof = moved[0][2]
    assert.equal(proof.signer, 'system')
    assert.deepEqual(Object.keys(proof.custom), ['detail', 'labels', 'moment'])
    assert.equal(proof.custom.detail, 'Reassigning {preferred} label to the record {a2}')
    assert.deepEqual(proof.custom.labels, { $pull: 'preferred' })
  })
})
