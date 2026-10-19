// DTC policies (recorded, dtc): validated like the reference, stored, not run.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDtc } from '../src/schemas.js'
import { LedgerError } from '../src/errors.js'

const policy = (values: unknown[], extra: Record<string, unknown> = {}) => ({ handle: 'p', schema: 'dtc', record: 'intent', values, ...extra })
const errorsOf = (data: unknown) => {
  try {
    validateDtc(data)
    return undefined
  } catch (e) {
    assert.ok(e instanceof LedgerError)
    return { detail: e.detail, errors: ((e as any).custom.errors as any[]).map((x) => `${x.path} ${x.message}`) }
  }
}
const own = (r: ReturnType<typeof errorsOf>) => r!.errors.filter((e) => e.startsWith('/body/data/values') || e.startsWith('/body/data/record') || e.startsWith('/body/data/config'))

describe('dtc policies', () => {
  test('every step kind, in both invoke forms, with filters and config', () => {
    const src = { $resolve: 'source' }
    assert.equal(
      errorsOf(
        policy(
          [
            { invoke: 'dtc.prepare', schema: 'debit', wallet: src },
            { invoke: 'dtc.prepare', schema: 'credit', bridge: { $resolve: 'target' } },
            { invoke: 'dtc.notify', schema: 'credit', action: 'confirm', bridge: 'bank' },
            { invoke: { method: 'dtc.setStatus' }, status: 'prepared', filter: { 'data.custom.x': 1 } },
            { invoke: 'flow.parallel', values: [{ invoke: 'dtc.commit', schema: 'credit' }, { invoke: 'core.prepare', values: [{ schema: 'debit', wallet: 'alice' }] }] },
            { invoke: 'core.commit', config: { suspendTimeoutMs: 60000 }, values: [{ schema: 'debit', wallet: src }] },
          ],
          { config: { priority: 0 }, filter: { 'data.custom.flow': 'a' } },
        ),
      ),
      undefined,
    )
  })

  test('a reserved notify action: the first error of every step kind', () => {
    assert.deepEqual(own(errorsOf(policy([{ invoke: 'dtc.notify', schema: 'credit', action: 'commit' }]))), [
      "/body/data/values/0/bridge must have required property 'bridge'",
      "/body/data/values/0/wallet must have required property 'wallet'",
      '/body/data/values/0 must match exactly one schema in oneOf',
      '/body/data/values/0/action must NOT have additional properties',
      '/body/data/values/0/action must NOT be valid',
      "/body/data/values/0/status must have required property 'status'",
      "/body/data/values/0/values must have required property 'values'",
      "/body/data/values/0/values must have required property 'values'",
      "/body/data/values/0/values must have required property 'values'",
      '/body/data/values/0 must match exactly one schema in oneOf',
    ])
  })

  test('the detail names an unexpected property at its parent', () => {
    const r = errorsOf(policy([{ invoke: 'dtc.prepare', schema: 'debit', wallet: 'a', bridge: 'b' }]))!
    assert.match(r.detail, /request\/body\/data\/values\/0 must NOT have additional properties/)
    assert.equal(own(r)[0], '/body/data/values/0/wallet must NOT have additional properties')
  })

  test('record, empty values and a negative priority', () => {
    assert.deepEqual(own(errorsOf(policy([{ invoke: 'dtc.setStatus', status: 'x' }], { record: 'wallet' }))), ['/body/data/record must be equal to one of the allowed values: intent'])
    assert.deepEqual(own(errorsOf(policy([]))), ['/body/data/values must NOT have fewer than 1 items'])
    assert.deepEqual(own(errorsOf(policy([{ invoke: 'dtc.setStatus', status: 'x' }], { config: { priority: -1 } }))), ['/body/data/config/priority must be >= 0'])
  })
})
