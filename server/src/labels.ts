// Labels (docs: structuring-data/labels, labels-policies; recorded, labels).
//
// A proof's `custom.labels` changes the record's `meta.labels`, at creation or later:
//
//   an array of strings      → appended (the docs say replaced; the reference appends,
//                              `[]` changes nothing)
//   `{$push: …}`             → a label, or `{$each, $position, $sort, $slice}` as in
//                              MongoDB: insert, sort the whole list, then cut it
//   `{$addToSet: …}`         → like `$push`, without labels the list had before (the
//                              new ones are not compared with each other)
//   `{$pull: …}`             → every occurrence of a label, or of those in `$in`
//   `{$pullAll: […]}`        → every occurrence of these
//   `{$pop: 1 | -1}`         → the last or the first label
//
// `meta.labels` is absent until a proof sets it, then the last key of `meta`.
//
// Labels policies pick records by `record` and `filter` (on `data`), active or not.
// Only labels a change adds are checked: each must be in some matching policy's
// `values[].labels`, else 422 `record.labels-policy-violation`; without a matching
// policy any label goes, and removing one always does. A value's `unique` names data
// fields: once a record gains such a label, every other record the policy picks that
// shares those fields and has the label loses it, by a proof the ledger signs.
import { serverProof, type KeyPair } from './crypto.js'
import { LedgerError } from './errors.js'
import { flatFilter, matches, parseQuery } from './query.js'
import type { Store, StoredRecord } from './store.js'

type Each = { $each: string[]; $position?: number; $sort?: 1 | -1; $slice?: number }
const eachOf = (v: string | Each): Each => (typeof v === 'string' ? { $each: [v] } : v)

function insert(list: string[], { $each, $position, $sort, $slice }: Each) {
  const at = $position === undefined ? list.length : Math.min($position, list.length)
  let out = [...list.slice(0, at), ...$each, ...list.slice(at)]
  if ($sort !== undefined) out = out.sort((a, b) => (a < b ? -$sort : a > b ? $sort : 0))
  if ($slice !== undefined) out = $slice >= 0 ? out.slice(0, $slice) : out.slice($slice)
  return out
}

/** The labels after one proof's expression (already validated: `validateLabels`). */
export function applyLabels(list: string[], expr: any): string[] {
  if (Array.isArray(expr)) return [...list, ...expr]
  if ('$push' in expr) return insert(list, eachOf(expr.$push))
  if ('$addToSet' in expr) {
    const each = eachOf(expr.$addToSet)
    return insert(list, { ...each, $each: each.$each.filter((l) => !list.includes(l)) })
  }
  if ('$pull' in expr) {
    const gone: string[] = typeof expr.$pull === 'string' ? [expr.$pull] : expr.$pull.$in
    return list.filter((l) => !gone.includes(l))
  }
  if ('$pullAll' in expr) return list.filter((l) => !expr.$pullAll.includes(l))
  return expr.$pop === 1 ? list.slice(0, -1) : list.slice(1)
}

/** The labels after these proofs, or undefined when none of them names any. */
export function labelsAfter(before: string[] | undefined, proofs: { custom?: any }[]) {
  let out = before
  for (const p of proofs) if (p.custom?.labels !== undefined) out = applyLabels(out ?? [], p.custom.labels)
  return out
}

const at = (data: unknown, path: string) => path.split('.').reduce<any>((v, k) => v?.[k], data)

async function policiesFor(store: Store, ledger: string, recordType: string, data: unknown) {
  return (await store.list(ledger, 'policies')).filter(
    (p) => p.data.schema === 'labels' && p.data.record === recordType && (!p.data.filter || matches(data as object, parseQuery(flatFilter(p.data.filter)))),
  )
}

/** Refuses labels no matching policy allows; returns the values whose `unique` applies. */
export async function checkLabels(store: Store, ledger: string, recordType: string, data: unknown, before: string[], after: string[]) {
  const added = [...new Set(after.filter((l) => !before.includes(l)))]
  if (!ledger || !added.length) return []
  const policies = await policiesFor(store, ledger, recordType, data)
  if (!policies.length) return []
  const values: { labels: string[]; unique?: string[] }[] = policies.flatMap((p) => p.data.values ?? [])
  const forbidden = added.filter((l) => !values.some((v) => v.labels.includes(l)))
  if (forbidden.length)
    throw new LedgerError(422, 'record.labels-policy-violation', `Labels not allowed by policy. Forbidden labels: ${forbidden.join(', ')}`, { labels: forbidden })
  return policies.flatMap((p) => (p.data.values as any[]).filter((v) => v.unique?.length && v.labels.some((l: string) => added.includes(l))).map((v) => ({ policy: p, labels: v.labels.filter((l: string) => added.includes(l)) as string[], unique: v.unique as string[] })))
}

/**
 * Takes the unique labels `record` just gained from every other record that shares the
 * policy's fields with it. Returns the records changed, each with its new proof.
 */
export async function reassign(store: Store, ledger: string, kind: string, record: StoredRecord, key: KeyPair, unique: Awaited<ReturnType<typeof checkLabels>>) {
  const changed: [StoredRecord, ReturnType<typeof serverProof>][] = []
  for (const { policy, labels, unique: fields } of unique) {
    for (const other of await store.list(ledger, kind)) {
      if (other.data.handle === record.data.handle) continue
      if (policy.data.filter && !matches(other.data as object, parseQuery(flatFilter(policy.data.filter)))) continue
      if (!fields.every((f) => JSON.stringify(at(other.data, f)) === JSON.stringify(at(record.data, f)))) continue
      for (const label of labels) {
        const current = changed.find(([r]) => r.data.handle === other.data.handle)?.[0] ?? other
        if (!(current.meta.labels ?? []).includes(label)) continue
        const proof = serverProof(current.hash, { detail: `Reassigning {${label}} label to the record {${record.data.handle}}`, labels: { $pull: label }, moment: new Date().toISOString() }, key, 'system')
        current.meta.proofs.push(proof)
        current.meta = { ...current.meta, labels: applyLabels(current.meta.labels, { $pull: label }) }
        changed.push([current, proof])
      }
    }
  }
  return changed
}
