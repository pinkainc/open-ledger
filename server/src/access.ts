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
import { errors, LedgerError } from './errors.js'
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
export type Scope = { ledger: StoredRecord; record?: StoredRecord; domain?: string; subject?: { data: any; meta?: any } }

/** The record a rule's `filter` and `invoke` look at: the one read or changed, or the one being created. */
const subjectOf = (scope: Scope) => scope.record ?? scope.subject

/**
 * A policy value's `filter` (recorded, policies3/4): keys name data fields relative to
 * `data` (`handle`, `schema`, `custom.x`) or `meta.*`; values are plain or operators
 * (`{$in: […]}`). Allowed keys per record kind are checked when the policy is made.
 */
function filterMatches(filter: Record<string, unknown>, subject: { data: any; meta?: any } | undefined) {
  if (!subject) return false
  return Object.entries(filter).every(([key, cond]) => {
    const [root, path] = key.startsWith('meta.') ? [subject.meta ?? {}, key.slice(5)] : [subject.data ?? {}, key]
    const v = path.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), root)
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Record<string, any>
      if (Array.isArray(c.$in) && !c.$in.includes(v)) return false
      if (Array.isArray(c.$nin) && c.$nin.includes(v)) return false
      if ('$eq' in c && c.$eq !== v) return false
      if ('$ne' in c && c.$ne === v) return false
      if (typeof c.$regex === 'string' && !(typeof v === 'string' && new RegExp(c.$regex).test(v))) return false
      return true
    }
    return v === cond
  })
}

// Allowed `filter` keys of an access policy value, per record kind (recorded, policies3/4;
// other kinds were not recorded and are not checked).
const FILTER_KEYS: Record<string, string[]> = {
  symbol: ['^handle$', '^schema$', '^factor$', '^custom..+$', '^meta.domain$', '^meta.labels$', '^meta.status$'],
  wallet: ['^handle$', '^schema$', '^bridge$', '^custom..+$', '^meta.domain$', '^meta.labels$', '^meta.status$'],
  intent: ['^handle$', '^schema$', '^custom..+$', '^meta.domain$', '^meta.labels$', '^meta.status$', '^meta.thread$'],
}
export function validateAccessFilters(policy: any) {
  if (policy?.schema !== 'access') return
  for (const v of Array.isArray(policy.values) ? policy.values : []) {
    const record = v?.record ?? policy.record
    const allowed = FILTER_KEYS[record]
    if (!allowed || !v?.filter || typeof v.filter !== 'object') continue
    for (const key of Object.keys(v.filter))
      if (!allowed.some((re) => new RegExp(re).test(key)))
        throw new LedgerError(422, 'record.schema-invalid', `Cannot define access filter key "${key}" for record "${record}". Allowed keys: ${JSON.stringify(allowed)}`)
  }
}

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
  async grants(r: any, action: string, record: string, access: Access, scope: Scope, level: Level = 'record') {
    const { who, proofs = [] } = access
    if (r.policy !== undefined) return false // expanded by `rules`
    if (r.action !== 'any' && !matchValue(r.action, action)) return false
    if (r.record === undefined) {
      if (level === 'ledger' && record !== 'ledger') return false
      if (level === 'domain' && record !== 'domain') return false
      if (level === 'server' && record !== 'server' && action !== 'access') return false
    } else if (!matchValue(r.record, record)) return false
    if (r.filter && typeof r.filter === 'object' && !filterMatches(r.filter, subjectOf(scope))) return false
    if (typeof r.invoke === 'string' && !(await this.invoke(r.invoke, access, scope))) return false
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

  /**
   * Values of the active access policies: the rules of a policy-based ledger. A policy in
   * a domain (`pay@payments`; recorded, policies3) holds only for records of that domain
   * and the domains below it: K, granted everything on wallets there, could neither
   * create a wallet outside it nor read one.
   */
  private async activePolicies(ledger: string, scope?: Scope): Promise<any[]> {
    const active = (await this.store.list(ledger, 'policies')).filter((p) => p.data.schema === 'access' && p.meta.status === 'active')
    const chain = scope ? await this.domainChain(ledger, scope) : []
    const out: any[] = []
    for (const p of active) if (p.meta.domain === undefined || chain.includes(p.meta.domain)) out.push(...(await this.policyValues(ledger, p.data.handle)))
    return out
  }

  /** The domain of the record (or of the one being created) and the domains above it. */
  private async domainChain(ledger: string, scope: Scope): Promise<string[]> {
    const out: string[] = []
    for (let d = scope.domain ?? scope.record?.meta?.domain; typeof d === 'string' && !out.includes(d); ) {
      out.push(d)
      d = (await this.store.get(ledger, 'domains', d))?.data.domain
    }
    return out
  }

  /**
   * Built-in checks a policy value may `invoke` (about-policies; recorded, policies3/4).
   * `intent.canSpendEveryClaimWallet` let K move from a wallet it may spend to one it may
   * not: only the claims' sources are asked for.
   */
  private async invoke(name: string, access: Access, scope: Scope): Promise<boolean> {
    const ledger = scope.ledger.data.handle
    const subject = subjectOf(scope)
    const may = async (action: string, handle: unknown) => {
      if (typeof handle !== 'string') return false
      const wallet = await this.store.get(ledger, 'wallets', handle)
      return !!wallet && (await this.allowed(action, 'wallet', access, { ledger: scope.ledger, record: wallet }))
    }
    const claimsOf = (i: any): any[] => (Array.isArray(i?.data?.claims) ? i.data.claims : [])
    const wallets = (claims: any[], ends: ('source' | 'target')[]) => claims.flatMap((c) => ends.map((e) => c?.[e]?.handle)).filter((h) => typeof h === 'string')
    const thread = async () => {
      const t = subject?.meta?.thread
      if (!t) return claimsOf(subject)
      return (await this.store.list(ledger, 'intents')).filter((i) => i.meta.thread === t).flatMap(claimsOf)
    }
    const some = async (action: string, hs: string[]) => {
      for (const h of hs) if (await may(action, h)) return true
      return false
    }
    const every = async (action: string, hs: string[]) => {
      for (const h of hs) if (!(await may(action, h))) return false
      return true
    }
    switch (name) {
      case 'intent.canReadAnyClaimWallet':
        return some('read', wallets(claimsOf(subject), ['source', 'target']))
      case 'intent.canReadAnyClaimWalletInThread':
        return some('read', wallets(await thread(), ['source', 'target']))
      case 'intent.canSpendEveryClaimWallet':
        return every('spend', wallets(claimsOf(subject), ['source']))
      case 'intent.canSpendAnyClaimWallet':
        return some('spend', wallets(claimsOf(subject), ['source', 'target']))
      case 'intent.canSpendAnyClaimWalletInThread':
        return some('spend', wallets(await thread(), ['source', 'target']))
      case 'wallet.canSpendAllChangedRouteTargets': {
        // Routes that forward or debit, new in this version, need `spend` on their target.
        const before = new Set(((scope.record?.data?.routes ?? []) as any[]).map((r) => JSON.stringify(r)))
        const routes = ((scope.subject?.data?.routes ?? scope.record?.data?.routes ?? []) as any[]).filter((r) => ['forward', 'debit'].includes(r?.action) && !before.has(JSON.stringify(r)))
        return every('spend', routes.map((r) => r.target))
      }
      default:
        return false
    }
  }

  /**
   * A policy-based ledger's list (recorded, policies3/4) keeps a record only for a value
   * granting `query` (or `any`) whose signer or bearer names the caller's token key: a
   * `read` value, filtered or not, shows nothing in a list.
   */
  async listable(record: string, access: Access, scope: Scope) {
    const key = access.who?.public
    if (!key) return false
    for (const r of await this.activePolicies(scope.ledger.data.handle, scope)) {
      const principal = r.signer ?? r.bearer?.$signer
      if (!principal || !(await this.grants({ ...r, signer: undefined, bearer: undefined }, 'query', record, {}, scope, 'ledger'))) continue
      if (await this.keyMatches(principal, key, scope)) return true
    }
    return false
  }

  /** Rules in force for a scope, with their level: the record's, the ledger's, the server's. */
  async rules(scope: Scope): Promise<[any, Level][]> {
    const ledger = scope.ledger.data.handle
    const server = this.serverRules.map((r) => [r, 'server'] as [any, Level])
    if (AccessControl.policyBased(scope.ledger)) return (await this.activePolicies(ledger, scope)).map((r) => [r, 'ledger'] as [any, Level])
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
      ? (await this.activePolicies(ledger, scope)).map((r) => [r, 'ledger'] as [any, Level])
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

  /**
   * Secrets in the clear (`include=meta.secret`; recorded, auth2): only a rule with a
   * `signer` whose key is the caller's token key, for `reveal` (or `any`). A bearer rule,
   * even `read` on `signer-factor-secret`, does not count. Refused with one error per
   * signer rule that would have granted for another key.
   */
  async authorizeReveal(record: string, access: Access, scope: Scope) {
    const errors: string[] = []
    for (const [r, level] of await this.rules(scope)) {
      if (!r.signer || !(await this.grants({ ...r, signer: undefined }, 'reveal', record, {}, scope, level))) continue
      if (access.who && (await this.keyMatches(r.signer, access.who.public, scope))) return
      errors.push('Cannot find required signer.')
    }
    throw new LedgerError(403, 'auth.forbidden', 'Missing permissions', { errors })
  }

  /** Server rules alone, for operations above any ledger (creating one). */
  async authorizeServer(action: string, record: string, access: Access) {
    const none = { ledger: { hash: '', data: { handle: '' }, luid: '', meta: {} } }
    for (const r of this.serverRules) if (await this.grants(r, action, record, access, none, 'server')) return
    throw errors.forbidden(action, record)
  }
}
