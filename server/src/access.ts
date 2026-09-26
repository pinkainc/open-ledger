// Access rules (docs: securing-the-ledger/about-authorization).
//
// A rule grants an action on a record type:
//   `signer` — matched against the signers of the request's proofs, so it only ever
//              grants mutations; a read carries no proofs.
//   `bearer` — matched against the JWT: its claims, and `$signer` against the key that
//              signed it.
//   neither  — grants to everyone, which is why `{action: any, record: any}` lets
//              anonymous reads through on the reference.
// Levels are additive: record, then ledger, then server; any single match grants.
// The reference's access check confirms the signer/read split: an owner's
// `{any, signer}` rule is not listed as granting `read`.
//
// Two rules established by recording (scenarios access2, access3), not stated plainly
// in the docs:
//   scope  — a ledger-level rule without `record` covers the ledger record only, like
//            a record-level rule covers its own record. `{action: any, signer: A}` on
//            a ledger lets A change the ledger but not create a symbol in it; that
//            takes `record: any` (or `symbol`).
//   gate   — a mutation inside a ledger also needs `access` on that ledger from the
//            ledger's own rules. With `{action: create, record: intent}` open to all,
//            a signer without `access` still cannot create an intent.
//
// Signer matchers: `public`, `handle` (a signer record of this ledger), `$circle`
// (membership through circle-signer records), `$record: owner` (a key in the record's
// `meta.owners`), `$ledger: owner` (a key in the ledger's owners), and `$in` of those.
import { errors } from './errors.js'
import type { Store, StoredRecord } from './store.js'

export type Principal = { public: string; claims: Record<string, unknown> }

export type Level = 'record' | 'ledger' | 'server'

/** What a request brings to an access decision. */
export type Access = { who?: Principal; proofs?: string[] }

/** Where it is evaluated: the ledger, and the record when there is one. */
export type Scope = { ledger: StoredRecord; record?: StoredRecord }

const matchValue = (v: any, x: string | undefined) => {
  if (v === undefined || v === 'any') return true
  if (x === undefined) return false
  if (typeof v === 'string') return v === x
  if (Array.isArray(v?.$in)) return v.$in.includes(x) && !(v.$nin ?? []).includes(x)
  if (Array.isArray(v?.$nin)) return !v.$nin.includes(x)
  if (typeof v?.$regex === 'string') return new RegExp(v.$regex).test(x)
  if (v?.$eq !== undefined) return v.$eq === x
  if (v?.$ne !== undefined) return v.$ne !== x
  return false
}

export class AccessControl {
  constructor(
    private readonly store: Store,
    private readonly serverRules: any[],
  ) {}

  private async signerRecords(ledger: string, key: string) {
    return (await this.store.list(ledger, 'signers')).filter((s) => s.data.public === key)
  }

  private async circlesOf(ledger: string, key: string) {
    const handles = new Set((await this.signerRecords(ledger, key)).map((s) => s.data.handle))
    if (!handles.size) return []
    return (await this.store.list(ledger, 'circle-signers')).filter((l) => handles.has(l.data.signer)).map((l) => l.data.circle)
  }

  /** Does `key` satisfy a signer matcher? */
  async keyMatches(m: any, key: string, scope: Scope): Promise<boolean> {
    if (!m || typeof m !== 'object') return false
    if (Array.isArray(m.$in)) {
      for (const x of m.$in) if (await this.keyMatches(x, key, scope)) return true
      return false
    }
    const ledger = scope.ledger.data.handle
    if (m.public !== undefined && !matchValue(m.public, key)) return false
    if (m.$record !== undefined && !(scope.record?.meta.owners ?? []).includes(key)) return false
    if (m.$ledger !== undefined && !(scope.ledger.meta.owners ?? []).includes(key)) return false
    if (m.handle !== undefined) {
      const signers = await this.signerRecords(ledger, key)
      if (!signers.some((s) => matchValue(m.handle, s.data.handle))) return false
    }
    if (m.$circle !== undefined) {
      const circles = await this.circlesOf(ledger, key)
      if (!circles.some((c) => matchValue(m.$circle, c))) return false
    }
    return true
  }

  /**
   * `level` is where the rule lives. A rule without `record` covers the record it is
   * attached to: the record itself, the ledger, or the server.
   */
  async grants(r: any, action: string, record: string, { who, proofs = [] }: Access, scope: Scope, level: Level = 'record') {
    if (r.policy !== undefined) return false // access policies: not yet
    if (r.action !== 'any' && !matchValue(r.action, action)) return false
    if (r.record === undefined) {
      if (level === 'ledger' && record !== 'ledger') return false
      if (level === 'server' && record !== 'server' && action !== 'access') return false
    } else if (!matchValue(r.record, record)) return false
    if (r.signer) {
      for (const k of proofs) if (await this.keyMatches(r.signer, k, scope)) return true
      return false
    }
    if (r.bearer) {
      if (!who) return false
      const { $signer, ...claims } = r.bearer
      if ($signer && !(await this.keyMatches($signer, who.public, scope))) return false
      return Object.entries(claims).every(([k, v]) => matchValue(v, who.claims[k] as string | undefined))
    }
    return true
  }

  /** Rules in force for a scope, with their level: the record's, the ledger's, the server's. */
  rules(scope: Partial<Scope>): [any, Level][] {
    // The ledger record's own rules are its ledger-level rules; don't count them twice.
    const own = scope.record && scope.record !== scope.ledger ? (scope.record.data.access ?? []) : []
    return [
      ...own.map((r: any) => [r, 'record'] as [any, Level]),
      ...(scope.ledger?.data.access ?? []).map((r: any) => [r, 'ledger'] as [any, Level]),
      ...this.serverRules.map((r) => [r, 'server'] as [any, Level]),
    ]
  }

  /** The rules that grant, each with the level it lives on. */
  async matching(action: string, record: string, access: Access, scope: Scope): Promise<[any, Level][]> {
    const out: [any, Level][] = []
    for (const [r, level] of this.rules(scope)) if (await this.grants(r, action, record, access, scope, level)) out.push([r, level])
    return out
  }

  async allowed(action: string, record: string, access: Access, scope: Scope) {
    for (const [r, level] of this.rules(scope)) if (await this.grants(r, action, record, access, scope, level)) return true
    return false
  }

  /** The ledger gate: `access` on the ledger, from the ledger's own rules. */
  async entered(access: Access, scope: Scope) {
    for (const r of scope.ledger.data.access ?? []) if (await this.grants(r, 'access', 'ledger', access, scope, 'ledger')) return true
    return false
  }

  async authorize(action: string, record: string, access: Access, scope: Scope) {
    if (action !== 'read' && !(await this.entered(access, scope))) throw errors.forbidden(action, record)
    if (!(await this.allowed(action, record, access, scope))) throw errors.forbidden(action, record)
  }

  /** Server rules alone, for operations above any ledger (creating one). */
  async authorizeServer(action: string, record: string, access: Access) {
    const none = { ledger: { hash: '', data: { handle: '' }, luid: '', meta: {} } }
    for (const r of this.serverRules) if (await this.grants(r, action, record, access, none, 'server')) return
    throw errors.forbidden(action, record)
  }
}
