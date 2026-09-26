// Status changes requested by proof (docs: structuring-data/status-policies), checked
// against the reference in the `access` scenario.
//
//   no status policy applies to the record  → the status is set
//   policies apply, none allows the target  → 422 record.status-policy-violation, the
//                                             proof is not stored
//   allowed, but the quorum has not signed  → the proof is stored, the status stays
//   allowed and every quorum member signed  → the status is set
//
// A quorum member is a signer matcher (`public`, `handle`, `$record: owner`, …); it is
// satisfied by any proof on the record that asks for the same status.
import type { AccessControl } from './access.js'
import type { Proof } from './crypto.js'
import { LedgerError } from './errors.js'
import type { Store, StoredRecord } from './store.js'

const statusMatches = (rule: any, target: unknown) => {
  if (rule === undefined) return true
  if (rule === null || typeof rule === 'string') return rule === target
  if (Array.isArray(rule?.$in)) return rule.$in.includes(target)
  if (Array.isArray(rule?.$nin)) return !rule.$nin.includes(target)
  return false
}

export async function applyStatus(store: Store, acl: AccessControl, ledger: StoredRecord, recordType: string, record: StoredRecord, proof: Proof) {
  const custom = proof.custom ?? {}
  if (!('status' in custom)) {
    record.meta.proofs.push(proof)
    return
  }
  const target = custom.status
  const policies = (await store.list(ledger.data.handle, 'policies')).filter(
    (p) => p.data.schema === 'status' && (!p.data.record || p.data.record === recordType) && p.meta.status !== 'inactive',
  )
  const set = () => {
    if (target === null) delete record.meta.status
    else record.meta.status = target
  }
  if (!policies.length) {
    record.meta.proofs.push(proof)
    set()
    return
  }

  const values = policies.flatMap((p) => p.data.values ?? []).filter((v: any) => statusMatches(v.status, target))
  if (!values.length)
    throw new LedgerError(422, 'record.status-policy-violation', `Cannot set ${recordType} status to ${target}. No values correspond to the target status.`)

  record.meta.proofs.push(proof)
  const asking = record.meta.proofs.filter((p: Proof) => p.custom && 'status' in p.custom && p.custom.status === target).map((p: Proof) => p.public)
  const scope = { ledger, record }
  for (const v of values) {
    let met = true
    for (const member of v.quorum ?? []) {
      let signed = false
      for (const k of asking) if (await acl.keyMatches(member, k, scope)) signed = true
      if (!signed) met = false
    }
    if (met) return set()
  }
}
