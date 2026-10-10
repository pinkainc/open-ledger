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
// Access policies (scenarios policies, policies2). A rule `{policy: handle}` stands for
// the values of that `schema: access` policy and of the policies it `extend`s, each
// value defaulting `record` to its policy's `record`. In a record-based ledger the
// policy's status does not matter and an unknown handle grants nothing. In a ledger
// with `access.strategy: policy-based` the ledger's and records' own rules no longer
// count: the rules in force are the values of the **active** access policies (an
// extended policy contributes whatever its status); not even the server's default
// `{read, record: ledger}` counts (policies2: C may enter but not read the ledger). The gate then
// needs an active policy granting `access` on the ledger (record `ledger` or `any`).
//
// The gate applies to reads as well, but a read also passes it when the ledger's or
// the server's rules grant that read directly: a wallet rule letting C read does not
// help C without `access` (policies2), a ledger rule `{read, record: any}` lets anyone
// read without `access` (access4), and so does the server's `{read, record: ledger}`.
//
// Domains (recorded, domains2): the rules of the domain a record is in, and of each
// domain above it, count for the record — between its own rules and the ledger's. A
// subdomain's rules do not reach up. A creation is judged by the domain the record is
// to join. Domain records themselves inherit nothing: a domain granting `{any, record:
// any}` does not let its key create a subdomain. In a domain's rules a signer matcher
// also takes the token's key, so `{any, record: any, signer: C}` lets C read too.
//
// Signer matchers: `public`, `handle` (a signer record of this ledger), `$circle`
// (membership through circle-signer records), `$record: owner` (a key in the record's
// `meta.owners`), `$ledger: owner` (a key in the ledger's owners), and `$in` of those.
import { errors } from './errors.js'
import type { Store, StoredRecord } from './store.js'

/**
 * Who a token speaks for: its key, its claims, and for an OAuth token the signer its
 * `sub` names and the origin impersonated proofs get (`oauth2-token`).
 */
export type Principal = { public: string; claims: Record<string, unknown>; signer?: string; origin?: string }

export type Level = 'record' | 'domain' | 'ledger' | 'server'

/** What a request brings to an access decision. */
export type Access = { who?: Principal; proofs?: string[] }

/**
 * Where it is evaluated: the ledger, and the record when there is one. `domain` is the
 * domain a record being created joins; an existing record's is its `meta.domain`.
 */
export type Scope = { ledger: StoredRecord; record?: StoredRecord; domain?: string }

const isDomain = (r?: StoredRecord) => typeof r?.luid === 'string' && r.luid.startsWith('$dom.')

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
    if (r.policy !== undefined) return false // expanded by `rules`
    if (r.action !== 'any' && !matchValue(r.action, action)) return false
    if (r.record === undefined) {
      if (level === 'ledger' && record !== 'ledger') return false
      if (level === 'domain' && record !== 'domain') return false
      if (level === 'server' && record !== 'server' && action !== 'access') return false
    } else if (!matchValue(r.record, record)) return false
    if (r.signer) {
      const keys = level === 'domain' && who ? [...proofs, who.public] : proofs
      for (const k of keys) if (await this.keyMatches(r.signer, k, scope)) return true
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

  /** The values a policy stands for, its `extend` chain included, with `record` defaulted. */
  private async policyValues(ledger: string, handle: string, seen = new Set<string>()): Promise<any[]> {
    if (seen.has(handle)) return []
    seen.add(handle)
    const p = (await this.store.list(ledger, 'policies')).find((x) => x.data.handle === handle && x.data.schema === 'access')
    if (!p) return []
    const own = (p.data.values ?? []).map((v: any) => (v.record === undefined && p.data.record !== undefined ? { ...v, record: p.data.record } : v))
    return [...(p.data.extend ? await this.policyValues(ledger, p.data.extend, seen) : []), ...own]
  }

  private async expand(ledger: string, rules: any[], level: Level): Promise<[any, Level][]> {
    const out: [any, Level][] = []
    for (const r of rules) {
      if (r?.policy !== undefined) for (const v of await this.policyValues(ledger, r.policy)) out.push([v, level])
      else out.push([r, level])
    }
    return out
  }

  static policyBased = (ledger: StoredRecord) => ledger.data.config?.['access.strategy'] === 'policy-based'

  /** Values of the active access policies: the rules of a policy-based ledger. */
  private async activePolicies(ledger: string): Promise<any[]> {
    const active = (await this.store.list(ledger, 'policies')).filter((p) => p.data.schema === 'access' && p.meta.status === 'active')
    const out: any[] = []
    for (const p of active) out.push(...(await this.policyValues(ledger, p.data.handle)))
    return out
  }

  /** Rules in force for a scope, with their level: the record's, the ledger's, the server's. */
  async rules(scope: Scope): Promise<[any, Level][]> {
    const ledger = scope.ledger.data.handle
    const server = this.serverRules.map((r) => [r, 'server'] as [any, Level])
    if (AccessControl.policyBased(scope.ledger)) return (await this.activePolicies(ledger)).map((r) => [r, 'ledger'] as [any, Level])
    // The ledger record's own rules are its ledger-level rules; don't count them twice.
    const own = scope.record && scope.record !== scope.ledger ? (scope.record.data.access ?? []) : []
    return [
      ...(await this.expand(ledger, own, 'record')),
      ...(await this.domainRules(ledger, scope)),
      ...(await this.expand(ledger, scope.ledger.data.access ?? [], 'ledger')),
      ...server,
    ]
  }

  /** The rules of the record's domain and the domains above it, nearest first. */
  private async domainRules(ledger: string, scope: Scope): Promise<[any, Level][]> {
    if (isDomain(scope.record)) return []
    const out: [any, Level][] = []
    const seen = new Set<string>()
    for (let d = scope.domain ?? scope.record?.meta?.domain; typeof d === 'string' && !seen.has(d); ) {
      seen.add(d)
      const domain = await this.store.get(ledger, 'domains', d)
      if (!domain) break
      out.push(...(await this.expand(ledger, domain.data.access ?? [], 'domain')))
      d = domain.data.domain
    }
    return out
  }

  /** The rules that grant, each with the level it lives on. */
  async matching(action: string, record: string, access: Access, scope: Scope): Promise<[any, Level][]> {
    const out: [any, Level][] = []
    for (const [r, level] of await this.rules(scope)) if (await this.grants(r, action, record, access, scope, level)) out.push([r, level])
    return out
  }

  /** Rules that would grant but for their signer: what an intent proof's refusal lists (bproofs). */
  async signerMisses(action: string, record: string, scope: Scope) {
    let n = 0
    for (const [r, level] of await this.rules(scope)) if (r.signer && (await this.grants({ ...r, signer: undefined }, action, record, {}, scope, level))) n++
    return n
  }

  async allowed(action: string, record: string, access: Access, scope: Scope) {
    for (const [r, level] of await this.rules(scope)) if (await this.grants(r, action, record, access, scope, level)) return true
    return false
  }

  /** The ledger gate: `access` on the ledger, from the ledger's own rules. */
  async entered(access: Access, scope: Scope) {
    const ledger = scope.ledger.data.handle
    const rules = AccessControl.policyBased(scope.ledger)
      ? (await this.activePolicies(ledger)).map((r) => [r, 'ledger'] as [any, Level])
      : await this.expand(ledger, scope.ledger.data.access ?? [], 'ledger')
    // A token's key counts as a signer here: `{access, signer: B}` lets B read with a
    // token (policies #12), although a signer rule never grants the read itself.
    const keys = { ...access, proofs: [...(access.proofs ?? []), ...(access.who ? [access.who.public] : [])] }
    for (const [r] of rules) if (await this.grants(r, 'access', 'ledger', keys, scope, 'ledger')) return true
    return false
  }

  async authorize(action: string, record: string, access: Access, scope: Scope) {
    const through = async () => {
      for (const [r, level] of await this.rules(scope)) if ((level === 'ledger' || level === 'server') && (await this.grants(r, action, record, access, scope, level))) return true
      return false
    }
    const open = action === 'read' && !AccessControl.policyBased(scope.ledger) && (await through())
    if (!(await this.entered(access, scope)) && !open) throw errors.forbidden(action, record)
    if (!(await this.allowed(action, record, access, scope))) throw errors.forbidden(action, record)
  }

  /**
   * A list (recorded, ledgers): the action is `query`, and only the ledger gate decides
   * — a signer the ledger lets in may list wallets although no rule lets it read one.
   * Which records the page then holds is `readable`'s business.
   */
  async authorizeQuery(record: string, access: Access, scope: Scope) {
    if (await this.entered(access, scope)) return
    if (!AccessControl.policyBased(scope.ledger)) {
      for (const [r, level] of await this.rules(scope)) if ((level === 'ledger' || level === 'server') && (await this.grants(r, 'read', record, access, scope, level))) return
    }
    throw errors.forbidden('query', record)
  }

  /** Server rules alone, for operations above any ledger (creating one). */
  async authorizeServer(action: string, record: string, access: Access) {
    const none = { ledger: { hash: '', data: { handle: '' }, luid: '', meta: {} } }
    for (const r of this.serverRules) if (await this.grants(r, action, record, access, none, 'server')) return
    throw errors.forbidden(action, record)
  }
}
