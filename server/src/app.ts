// HTTP surface of the ledger. Routes, envelopes and error codes follow the Minka
// Ledger API as the official SDK and CLI use it; everything behind them is ours.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose'
import { createPrivateKey, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto'
import { customAlphabet } from 'nanoid'
import { createReadStream, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { AccessControl, type Access, type Principal } from './access.js'
import { Core, hasTrait } from './core.js'
import { resolveAddress } from './routing.js'
import { digestFor, generateKeyPair, hashData, publicKeyObject, serverProof, signDigest, verifyDigest, type KeyPair, type Proof } from './crypto.js'
import { LedgerError, errors } from './errors.js'
import { newLuid, newThread } from './ids.js'
import { matches, parseQuery, unsupportedFilters } from './query.js'
import { validateBody, validateLedgerDrop, validateProcessing, validateReportProof, type ValidatedKind } from './schemas.js'
import { CAUSED_BY, ForwardedError, aspectFor, forward, type Action, type Aspect } from './forwarding.js'
import { describe, redact } from './journal.js'
import { keyOf, type Store, type StoredRecord } from './store.js'
import { applyStatus } from './status.js'
import { secretRefs } from './secrets.js'
import { SYSTEM_SCHEMAS } from './system-schemas.js'
import { checkContent, schemaNotFound, schemaRequired, validateData } from './user-schemas.js'
import { checkAssets, objectPath, statusChange } from './reports.js'

export type AppOptions = {
  store: Store
  core?: Core
  /**
   * Server-level access rules, consulted after record and ledger rules. The default
   * lets any authenticated signer create a ledger, as the public reference does.
   */
  serverRules?: any[]
  /** Called for every registered route; used by the coverage report. */
  onRoute?: (method: string, url: string) => void
  /**
   * What `GET /api/v2` reports. `url` is the address clients use; without it the
   * address is taken from the request (`Host`, `X-Forwarded-Proto`).
   */
  server?: { handle?: string; url?: string }
  /**
   * Report assets (reports.ts): the reporting bucket every asset must name (any, when
   * unset), and the local directory `GET /reports/{id}/assets/{asset}` serves them from.
   */
  reports?: { bucket?: string; dir?: string }
  /**
   * Off by default, as on the public reference (recorded, ledgers): `ledgerDrop` lets an
   * owner drop a whole ledger (`DELETE /ledger`, `POST /ledger`); `journal` keeps the
   * request journal `GET /system/requests` reads (journal.ts).
   */
  ledgerDrop?: boolean
  journal?: boolean
}

/** The reference release whose API this server answers (published spec version). */
export const SEMVER = '2.47.4'

// Record kinds: path segment → luid prefix, name used in error details, and the
// record type access rules refer to. Prefixes are the reference's.
const KINDS = {
  ledgers: { luid: '$ldg', name: 'Ledger', record: 'ledger' },
  symbols: { luid: '$sym', name: 'Symbol', record: 'symbol' },
  wallets: { luid: '$wlt', name: 'Wallet', record: 'wallet' },
  intents: { luid: '$int', name: 'Intent', record: 'intent' },
  signers: { luid: '$snr', name: 'Signer', record: 'signer' },
  circles: { luid: '$crc', name: 'Circle', record: 'circle' },
  policies: { luid: '$plc', name: 'Policy', record: 'policy' },
  'circle-signers': { luid: '$csn', name: 'Circle signer', record: 'circle-signer' },
  bridges: { luid: '$brg', name: 'Bridge', record: 'bridge' },
  schemas: { luid: '$sch', name: 'Schema', record: 'schema' },
  effects: { luid: '$eff', name: 'Effect', record: 'effect' },
  anchors: { luid: '$anc', name: 'Anchor', record: 'anchor' },
  domains: { luid: '$dom', name: 'Domain', record: 'domain' },
  factors: { luid: '$snf', name: 'Signer Factor', record: 'signer-factor' },
  reports: { luid: '$rep', name: 'Report', record: 'report' },
} as const
type Kind = keyof typeof KINDS

/** Kinds with the full record surface under `/api/v2/<kind>`. */
const TOP_LEVEL = ['symbols', 'wallets', 'intents', 'signers', 'circles', 'policies', 'bridges', 'schemas', 'effects', 'anchors', 'domains', 'reports'] as const
/** Kinds a client may update after creation. Intents are immutable; reports change by proof only (no PUT in the spec). */
const MUTABLE = ['symbols', 'wallets', 'signers', 'circles', 'policies', 'bridges', 'schemas', 'effects', 'anchors', 'domains'] as const

const PAGE_LIMIT = 20
// Any caller may reach the server, read a ledger record, and (signed) create a ledger.
// The reference let every caller read every ledger it was asked for.
const DEFAULT_SERVER_RULES = [{ action: 'access' }, { action: 'read', record: 'ledger' }, { action: 'create', record: 'ledger' }]

declare module 'fastify' {
  interface FastifyRequest {
    /** Signer of the ledger this request addresses, once it has been resolved. */
    ledgerKey?: KeyPair
  }
}

export function buildApp({ store, core = new Core(store), onRoute, serverRules = DEFAULT_SERVER_RULES, server = {}, reports = {}, ledgerDrop = false, journal = false }: AppOptions) {
  const app = Fastify({ logger: false })
  if (onRoute) app.addHook('onRoute', (r) => [r.method].flat().forEach((m) => onRoute(m, r.url)))
  const acl = new AccessControl(store, serverRules)
  core.access ??= acl
  const now = () => new Date().toISOString()

  // Each ledger gets its own `system` signer when it is created, and everything the
  // ledger emits — errors included — is hashed and signed with it, so a client can
  // prove what the ledger told it. Before a ledger is resolved there is no signer,
  // and the reference ledger then answers with `proofs: []`.
  const envelope = (key: KeyPair | undefined, data: unknown, extra: Record<string, unknown> = {}) => {
    const hash = hashData(data)
    const moment = now()
    const proofs = key ? [serverProof(hash, { moment }, key, 'system')] : []
    return { hash, data, meta: { proofs, moment }, ...extra }
  }

  function toLedgerError(err: any): LedgerError {
    if (err instanceof LedgerError) return err
    // An empty JSON body never reaches the handler; report it as the missing `data`.
    if (err?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      try {
        validateBody('wallets', {})
      } catch (v) {
        return v as LedgerError
      }
    }
    console.error(err)
    return new LedgerError(500, 'api.internal-error', 'Internal error.')
  }

  app.setErrorHandler((err, req, reply) => {
    const e = toLedgerError(err)
    const data: Record<string, unknown> = { reason: e.reason, detail: e.detail }
    if (e.custom) data.custom = e.custom
    // A bridge's error (forwarding.ts): its proofs, then the ledger's naming the cause.
    if (e instanceof ForwardedError && req.ledgerKey) {
      const hash = hashData(data)
      const moment = now()
      return reply.status(e.status).send({ hash, data, meta: { proofs: [...e.proofs, serverProof(hash, { moment, causedBy: CAUSED_BY }, req.ledgerKey, 'system')], moment } })
    }
    reply.status(e.status).send(envelope(req.ledgerKey, data))
  })
  app.setNotFoundHandler((req, reply) => {
    const e = errors.routeNotFound()
    reply.status(e.status).send(envelope(req.ledgerKey, { reason: e.reason, detail: e.detail }))
  })

  // The reference ledger resolves the addressed ledger before any validation, so even
  // a schema or token error inside a ledger comes back signed by that ledger.
  app.addHook('onRequest', async (req) => {
    const handle = req.headers['x-ledger']
    if (typeof handle === 'string' && handle) req.ledgerKey = await store.getKey(handle)
  })

  // ---- authentication ------------------------------------------------------------

  // Bearer tokens are JWTs. An EdDSA token is signed by the caller, `kid` carrying the
  // raw public key. An RS256 token was issued by an OAuth provider (`/oauth/token`, or
  // an external one): `kid` names the provider's key-pair factor, whose signer an
  // `authentication` policy must name. A request without a token is anonymous —
  // access rules decide what it may do. A token that is present but does not verify
  // is rejected outright.
  async function authenticate(req: FastifyRequest): Promise<Principal | undefined> {
    const header = req.headers.authorization
    if (!header) return undefined
    if (!header.startsWith('Bearer ')) throw errors.unauthorized()
    const token = header.slice(7)
    let who: Principal
    try {
      const { kid, alg } = decodeProtectedHeader(token)
      if (typeof kid !== 'string') throw new Error('kid')
      if (alg === 'RS256') who = await oauthPrincipal(req, token, kid)
      else {
        const { payload } = await jwtVerify(token, publicKeyObject(kid), { algorithms: ['EdDSA'] })
        who = { public: kid, claims: payload }
      }
    } catch {
      throw errors.unauthorized()
    }
    checkHsh(req, who.claims.hsh)
    return who
  }

  // The `hsh` claim binds a token to one request (about-authentication): sha256 of
  // `{method, url, headers, body}`, then `:` and the protected header names. The URL is
  // the absolute one the client used, so behind a proxy the server needs PUBLIC_URL.
  // Recorded (hsh): checked against the server's public address, query included; an
  // empty `hsh` binds nothing; a protected header must hash with its value; a body is
  // `null` when absent. Runs before anything changes the body (impersonation adds proofs).
  function checkHsh(req: FastifyRequest, hsh: unknown) {
    if (hsh === undefined || hsh === '') return
    if (typeof hsh !== 'string') throw errors.unauthorized()
    const at = hsh.indexOf(':')
    const hash = at < 0 ? hsh : hsh.slice(0, at)
    const names = at < 0 ? [] : hsh.slice(at + 1).split(',').filter(Boolean)
    const headers = names.length ? Object.fromEntries(names.map((n) => [n, req.headers[n.toLowerCase()]])) : null
    const body = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : null
    let url: string
    try {
      url = decodeURIComponent(publicBase(req) + req.url.slice('/api/v2'.length))
    } catch {
      throw errors.unauthorized()
    }
    if (hashData({ method: req.method, url, body, headers }) !== hash) throw errors.unauthorized()
  }

  // The `oauth2` values of the ledger's authentication policies (authenticate-with-oauth);
  // a policy counts unless it is inactive.
  async function oauthProviders(scope: string): Promise<any[]> {
    const policies = (await store.list(scope, 'policies')).filter((p) => p.data.schema === 'authentication' && p.meta.status !== 'inactive')
    return policies.flatMap((p) => (p.data.values ?? []).filter((v: any) => v?.schema === 'oauth2' && typeof v.signer?.handle === 'string'))
  }

  // An RS256 token: verified with the public key (SPKI DER, base64) of the key-pair
  // factor its `kid` names, which must belong to a provider signer. The principal is
  // the signer the token's `sub` names, when the ledger has it.
  async function oauthPrincipal(req: FastifyRequest, token: string, kid: string): Promise<Principal> {
    const scope = req.headers['x-ledger']
    if (typeof scope !== 'string' || !scope) throw new Error('no ledger')
    const factor = await store.get(scope, 'factors', kid)
    if (factor?.data.schema !== 'key-pair' || !(await oauthProviders(scope)).some((v) => v.signer.handle === factor.data.signer)) throw new Error('kid')
    const key = createPublicKey({ key: Buffer.from(String(factor.data.public), 'base64'), format: 'der', type: 'spki' })
    const { payload } = await jwtVerify(token, key, { algorithms: ['RS256'] })
    const sub = typeof payload.sub === 'string' ? await store.get(scope, 'signers', payload.sub) : undefined
    return { public: sub?.data.public ?? '', claims: payload, origin: 'oauth2-token', ...(sub ? { signer: sub.data.handle } : {}) }
  }

  // The address clients use, `…/api/v2`: PUBLIC_URL, or the request's own host.
  function publicBase(req: FastifyRequest) {
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol
    return server.url ?? `${proto}://${req.headers.host}/api/v2`
  }

  const IMPERSONATED = new Set(['self-signed-token', 'oauth2-token'])
  const proofKeys = (body: any): string[] => (body?.meta?.proofs ?? []).map((p: any) => p.public)

  // ---- token impersonation -------------------------------------------------------

  // When the token's key belongs to a signer record of the ledger, the ledger's
  // `system.auth` signer signs the request on that signer's behalf
  // (about-authentication, "token impersonation"). The proof carries the token's
  // claims as `bearer.*`, `origin: self-signed-token`, and the signer and issuer
  // handles. Observed (access3): it is added even when the client signed the body
  // itself, and its key becomes an owner. A token whose key is not a signer record
  // impersonates nothing (access, l0). An OAuth token impersonates the signer its `sub`
  // names, with `origin: oauth2-token` and the provider as issuer (recorded, oauth).
  //
  // Partial proofs — without `public` — are templates: each becomes an impersonated
  // proof carrying its `custom`. A body with no proofs and no hash is hashed here.
  // Returns the keys access rules see: the token's key stands for the proofs made
  // on its behalf.
  async function impersonate(body: any, ledger: string, who: Principal | undefined, status?: string): Promise<string[]> {
    const signer = who && (who.signer ?? (await signerByKey(ledger, who.public)))
    const auth = signer && (await store.getKey(ledger, 'system.auth'))
    if (!who || !signer || !auth) return proofKeys(body)
    body.hash ??= hashData(body.data)
    body.meta ??= {}
    const given: any[] = body.meta.proofs ?? []
    const full = given.filter((p) => p?.public)
    const templates = given.filter((p) => !p?.public)
    if (!templates.length) templates.push({ custom: { ...(status || full[0]?.custom?.status ? { status: full[0]?.custom?.status ?? status } : {}) } })
    const issuer = typeof who.claims.iss === 'string' ? ((await signerByKey(ledger, who.claims.iss)) ?? who.claims.iss) : undefined
    const bearer = Object.fromEntries(Object.keys(who.claims).sort().map((k) => [`bearer.${k}`, who.claims[k]]))
    const made = templates.map((t) => ({
      ...serverProof(body.hash, { moment: now(), ...t.custom, ...bearer }, auth, signer),
      origin: who.origin ?? 'self-signed-token',
      ...(issuer ? { issuer } : {}),
    }))
    body.meta.proofs = [...full, ...made]
    return [...full.map((p) => p.public), who.public]
  }

  const signerByKey = async (ledger: string, key: string) =>
    (await store.list(ledger, 'signers')).find((s) => s.data.public === key)?.data.handle as string | undefined

  // ---- lookups ------------------------------------------------------------------

  async function hostedLedger(req: FastifyRequest) {
    const handle = req.headers['x-ledger']
    if (typeof handle !== 'string' || !handle) throw errors.ledgerNotHosted()
    const ledger = await store.get('', 'ledgers', handle)
    if (!ledger) throw errors.ledgerNotHosted()
    return ledger
  }

  // A path id is either a handle or, when it has the kind's luid prefix, a luid.
  const find = (scope: string, kind: Kind, id: string) =>
    id.startsWith(`${KINDS[kind].luid}.`) ? store.getByLuid(scope, kind, id) : store.get(scope, kind, id)

  async function existing(req: FastifyRequest, kind: Kind, id: string) {
    const ledger = await hostedLedger(req)
    const found = await find(ledger.data.handle, kind, id)
    if (!found) throw errors.notFound(KINDS[kind].name)
    return { ledger, found }
  }

  // ---- proofs -------------------------------------------------------------------

  function verifyProofs(body: any): Proof[] {
    const proofs: Proof[] = body.meta?.proofs ?? []
    if (!proofs.length) throw errors.signatureMissing()
    if (body.hash !== hashData(body.data)) throw errors.hashInvalid(body.hash)
    for (const p of proofs) {
      if (p.digest !== digestFor(body.hash, p.custom) || !verifyDigest(p.digest, p.public, p.result))
        throw errors.signatureInvalid(p.public)
    }
    return proofs
  }

  // Client proofs are stored tagged with their origin and, when the key belongs to a
  // signer record of the ledger, that signer's handle (observed: a proof by signer
  // `b` comes back with `signer: "b"`). What a client claims about a proof — origin,
  // signer, issuer — is replaced; only proofs `system.auth` made keep theirs.
  async function annotate(ledger: string, proofs: Proof[], origin = true): Promise<Proof[]> {
    const signers = ledger ? await store.list(ledger, 'signers') : []
    const auth = ledger ? (await store.getKey(ledger, 'system.auth'))?.public : undefined
    return proofs.map((p: any) => {
      if (auth && p.public === auth && IMPERSONATED.has(p.origin)) return p
      const { origin: _o, signer: _s, issuer: _i, ...plain } = p
      const signer = signers.find((s) => s.data.public === p.public)?.data.handle
      return { ...plain, ...(origin ? { origin: 'key-pair' } : {}), ...(signer ? { signer } : {}) }
    })
  }

  // ---- record creation -----------------------------------------------------------

  // A change is the full record as it was after one create/update, numbered from 1.
  // Anchors' changes carry no `labels` (recorded, anchors); every other kind's `null`.
  const snapshot = (r: StoredRecord, change: number, action: 'create' | 'update', moment = r.meta.moment, labels = true): StoredRecord => ({
    ...r,
    meta: { ...r.meta, moment, change, action, ...(labels ? { labels: null } : {}) },
  })

  async function addChange(scope: string, kind: Kind, r: StoredRecord, action: 'create' | 'update', moment?: string) {
    const n = (await store.changes(scope, kind, keyOf(r))).length + 1
    await store.addChange(scope, kind, keyOf(r), snapshot(r, n, action, moment, kind !== 'anchors'))
  }

  // An event about a record (effects): `<record>-<what>`, linked to the record.
  const intentVersion = (r: StoredRecord) => ({ hash: r.hash, data: r.data, luid: r.luid, meta: r.meta })
  const raise = (scope: string, kind: Kind, what: string, payload: Record<string, unknown>, r: StoredRecord) =>
    core.announce(scope, `${KINDS[kind].record}-${what}`, payload, { record: KINDS[kind].record, linked: keyOf(r) })

  // ---- secrets (secrets.ts; recorded, secure) -----------------------------------------

  // Every `{{ secret.<name> }}` in a record's data needs its value in `meta.secret` —
  // unless an earlier version already referred to it. Checked before anything is
  // written; the values are sealed only once the record is.
  function secretsOf(data: unknown, meta: any, previous?: StoredRecord): [string, string][] {
    const given = meta?.secret ?? {}
    const kept = previous ? secretRefs(previous.data) : new Set<string>()
    const out: [string, string][] = []
    for (const name of secretRefs(data)) {
      if (typeof given[name] === 'string') out.push([name, given[name]])
      else if (!kept.has(name))
        throw new LedgerError(422, 'record.invalid', `Record data has a secret reference to new secret '${name}' but no secret value was provided in 'meta.secret.${name}'`)
    }
    return out
  }

  async function keepSecrets(scope: string, kind: Kind, handle: string, values: [string, string][]) {
    for (const [name, value] of values) {
      const at = `${KINDS[kind].record}/${handle}/${name}`
      await store.putSecret(scope, at, core.secrets.seal(value, `${scope}/${at}`))
    }
  }

  // Stores a new record and returns it; the caller answers only after everything the
  // record depends on is written, so a client's next request never outruns it.
  // `finish` sees the record before it is stored and may replace it (anchor forwarding).
  async function create(kind: Kind, scope: string, key: KeyPair, req: FastifyRequest, finish?: (r: StoredRecord) => Promise<StoredRecord>) {
    const body = req.body as any
    const proofs = verifyProofs(body)
    const secrets = kind === 'intents' ? [] : secretsOf(body.data, body.meta)
    const luid = newLuid(KINDS[kind].luid)
    const moment = now()
    const sign = (custom: Record<string, unknown>) => serverProof(body.hash, custom, key, 'system')
    const owners = [...new Set(proofs.map((p) => p.public))]
    // Circle-signer links come back with the client proof untouched (no origin) and
    // without a status, unlike every other record.
    const link = kind === 'circle-signers'
    const clientProofs = await annotate(scope, proofs, !link)
    const domain = !scope ? undefined : await domainOf(scope, body.data.handle, proofs)

    let record: StoredRecord
    if (kind === 'intents')
      record = {
        hash: body.hash,
        data: body.data,
        luid,
        // An intent is accepted as `pending` and processed after the response.
        meta: {
          proofs: [...clientProofs, sign({ moment, status: 'pending' }), sign({ luid, moment: now(), status: 'pending' })],
          status: 'pending',
          thread: newThread(),
          domains: await intentDomains(scope, body.data.claims),
          moment,
          owners,
          // Recorded (domains2): an intent joins the domain its proof names, like any record.
          ...(domain ? { domain } : {}),
        },
      }
    else
      record = {
        hash: body.hash,
        // The reference ledger materialises an absent ledger `config` as null after
        // the client hashed the data, so the stored data no longer hashes to `hash`.
        // Clients may depend on the field, so the quirk is reproduced.
        // Likewise a subdomain gets its parent as `data.domain`, after the handle (domains).
        data:
          kind === 'ledgers'
            ? { ...body.data, config: body.data.config ?? null }
            : kind === 'domains' && domain
              ? { handle: body.data.handle, domain, ...body.data }
              : body.data,
        luid,
        meta: {
          proofs: [...clientProofs, sign({ luid, moment: now(), status: 'created' })],
          ...(link ? {} : { status: 'created' }),
          moment,
          owners,
          ...(domain ? { domain } : {}),
        },
      }
    if (finish) record = await finish(record)
    if (!(await store.insert(scope, kind, record))) throw errors.duplicated(KINDS[kind].name, body.data.handle)
    await keepSecrets(scope, kind, keyOf(record), secrets)
    await addChange(scope, kind, record, 'create')
    if (scope && kind !== 'circle-signers') await raise(scope, kind, 'created', { [KINDS[kind].record]: record }, record)
    // Recorded (reports, signals2: reports, wallets, intents): the ledger's own `created`
    // proof counts as added proofs.
    if (scope && kind !== 'circle-signers')
      await raise(scope, kind, 'proofs-added', { proofs: [record.meta.proofs.at(-1)], [KINDS[kind].record]: keyOf(record) }, record)
    if (kind === 'intents') core.schedule(scope, body.data.handle)
    return record
  }

  // A record joins a domain at creation (about-domains; recorded, domains): the one a
  // proof names in `custom.domain`, else the suffix of a handle with exactly one `@`
  // (`treasury@payments`; `w@eu@payments` joins none) once the ledger has domains.
  // The domain must exist.
  async function namedDomain(scope: string, handle: unknown, proofs: Proof[]) {
    const named = proofs.map((p) => p.custom?.domain).find((d) => typeof d === 'string') as string | undefined
    const parts = typeof handle === 'string' ? handle.split('@') : []
    const suffix = parts.length === 2 ? parts[1] : undefined
    if (named !== undefined) return named
    // Recorded (domains3): with `domain.resolutionFromHandleEnabled: false` the suffix is
    // only a part of the handle, neither a domain nor checked; a proof still names one.
    const byHandle = (await store.get('', 'ledgers', scope))?.data.config?.['domain.resolutionFromHandleEnabled'] !== false
    return byHandle && suffix && (await store.list(scope, 'domains')).length ? suffix : undefined
  }
  const joining = (scope: string, body: any) => namedDomain(scope, body?.data?.handle, body?.meta?.proofs ?? [])
  async function domainOf(scope: string, handle: unknown, proofs: Proof[]) {
    const domain = await namedDomain(scope, handle, proofs)
    if (domain && !(await store.get(scope, 'domains', domain)))
      throw new LedgerError(422, 'record.relation-not-found', `Trying to set a domain which doesn't exist "${domain}" to the record "${handle}"`, { domain })
    return domain
  }

  // An intent's `meta.domains`: the domains of the wallets its claims name.
  async function intentDomains(scope: string, claims: any[]) {
    const out: string[] = []
    for (const c of claims ?? [])
      for (const w of [c?.source, c?.target, c?.wallet]) {
        const handle = typeof w === 'string' ? w : w?.handle
        if (typeof handle !== 'string') continue
        const d = ((await store.get(scope, 'wallets', handle)) ?? (await resolveAddress(store, scope, handle)))?.meta.domain
        if (typeof d === 'string' && !out.includes(d)) out.push(d)
      }
    // Recorded (domains3): a read shows them sorted; lists in no fixed order.
    return out.sort()
  }

  // The ledger publishes its server signers as signer records, each self-signed and
  // countersigned by `system`. Their secrets live elsewhere; the record only holds a
  // reference in the reference's `{{ secret.<id> }}` form.
  async function publishSigner(ledger: string, handle: string, key: KeyPair, system: KeyPair) {
    const secretId = customAlphabet('abcdefghijklmnopqrstuvwxyz', 16)()
    const data = { handle, access: [{ action: 'read' }], format: key.format, public: key.public, secret: `{{ secret.${secretId} }}` }
    const hash = hashData(data)
    const luid = newLuid('$snr')
    const moment = now()
    const { signer: _s, origin: _o, ...self } = serverProof(hash, { moment, status: 'created' }, key, handle)
    const record: StoredRecord = {
      hash,
      data,
      luid,
      meta: { proofs: [self, serverProof(hash, { luid, moment: now(), status: 'created' }, system, 'system')], status: 'created', moment, owners: [key.public] },
    }
    await store.insert(ledger, 'signers', record)
    await addChange(ledger, 'signers', record, 'create')
  }

  // Every ledger is created with two status policies of its own (records2): intents
  // change status only by the ledger's `system` signer, and access policies move
  // between created, active and inactive. Signed by `system` itself (a bare proof
  // without custom), countersigned with the luid, dated with the ledger, no status.
  const SYSTEM_POLICIES = [
    {
      handle: 'access-policy:status',
      custom: { description: 'Defines available status for access policy records' },
      values: [{ quorum: [], status: { $in: ['created', 'active', 'inactive'] } }],
      record: 'policy',
      filter: { schema: 'access' },
      schema: 'status',
    },
    {
      handle: 'intent:status',
      custom: { description: 'Defines quorum for changing an intent status' },
      values: [
        {
          quorum: [{ handle: 'system' }],
          status: { $in: ['created', 'pending', 'prepared', 'committed', 'completed', 'failed', 'aborted', 'rejected', 'expired'] },
        },
      ],
      record: 'intent',
      schema: 'status',
    },
  ]

  async function publishPolicies(ledger: StoredRecord, system: KeyPair) {
    await publishSystem(ledger, system, 'policies', '$plc', SYSTEM_POLICIES)
    // Listed in this order on the reference (lists are newest first).
    await publishSystem(ledger, system, 'schemas', '$sch', [...SYSTEM_SCHEMAS].reverse())
  }

  // System records (policies, schemas) are signed by `system` itself (a bare proof
  // without custom), countersigned with the luid, dated with the ledger, no status.
  async function publishSystem(ledger: StoredRecord, system: KeyPair, kind: Kind, prefix: string, rows: readonly object[]) {
    for (const data of rows) {
      const hash = hashData(data)
      const luid = newLuid(prefix)
      const digest = digestFor(hash)
      const self = { method: 'ed25519-v2', public: system.public, digest, result: signDigest(digest, system) }
      const record: StoredRecord = {
        hash,
        data,
        luid,
        meta: { proofs: [self, serverProof(hash, { luid, moment: now() }, system, 'system')], moment: ledger.meta.moment, owners: [system.public] },
      }
      await store.insert(ledger.data.handle, kind, record)
      await addChange(ledger.data.handle, kind, record, 'create')
    }
  }

  // ---- lists ---------------------------------------------------------------------

  // Pagination arrives as `?page.index=1&page.limit=2` (the SDK's encoding); the
  // bracket form is accepted too. The page object echoes what was applied.
  function pageParams(req: FastifyRequest) {
    const q = req.query as Record<string, string | undefined>
    const num = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d)
    const index = num(q['page.index'] ?? q['page[index]'], 0)
    const limit = Math.max(1, num(q['page.limit'] ?? q['page[limit]'], PAGE_LIMIT))
    return { index, limit }
  }
  const slice = <T>(rows: T[], p: { index: number; limit: number }) => rows.slice(p.index * p.limit, (p.index + 1) * p.limit)

  // Record lists come newest first and carry no total. Filters (`query.ts`) come
  // before paging; the CLI asks `GET /schemas?data.record=wallet` and
  // `GET /policies?data.record.$in[0]=any&…` before every create.
  function listPage(req: FastifyRequest, rows: StoredRecord[]) {
    const p = pageParams(req)
    // Recorded (filters): keys outside `data.` and `meta.` (`luid`, `hash`, …) are ignored.
    const q = parseQuery(Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).filter(([k]) => /^(data|meta)\.|^\$plainTextQuery$/.test(k))))
    const kept = rows.filter((r) => matches(r, q)).reverse()
    // Recorded (uschema2): newest change first — an updated record moves to the top.
    // Records of one moment (a ledger's system records) keep newest-created first.
    const at = (r: StoredRecord) => String(r.meta.moment ?? '')
    kept.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0))
    return envelope(req.ledgerKey, slice(kept, p), { page: p })
  }

  // Changes list newest first, with a total.
  async function changePage(req: FastifyRequest, scope: string, kind: Kind, key: string) {
    const all = (await store.changes(scope, kind, key)).reverse()
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice(all, p), { page: { ...p, total: all.length } })
  }

  // ---- server --------------------------------------------------------------------

  // Server information, unsigned (no ledger is addressed). `minka server connect`
  // reads it and refuses a server that does not answer.
  const info = async (req: FastifyRequest) => {
    const url = publicBase(req)
    const data = { handle: server.handle ?? 'open-ledger', server: url, semver: SEMVER, status: 'UP' }
    return { hash: hashData(data), data, meta: { moment: now() } }
  }
  app.get('/api/v2', info)
  app.get('/api/v2/', info)

  // ---- ledgers -------------------------------------------------------------------

  // Anyone may create a signed ledger (server rule). The ledger gets four
  // signers of its own: `system` signs what the ledger says, `core` signs its part as
  // a participant in moving balances; `system.auth` and `system.dtc` are published
  // like on the reference and reserved for token impersonation and data transfer.
  app.post('/api/v2/ledgers', async (req, reply) => {
    validateBody('ledgers', req.body)
    // No token needed: `minka ledger create` sends none. The proofs sign the request.
    const who = await authenticate(req)
    await acl.authorizeServer('create', 'ledger', { who, proofs: proofKeys(req.body) })
    const handle = (req.body as any).data.handle
    const keys = { system: generateKeyPair(), core: generateKeyPair(), 'system.auth': generateKeyPair(), 'system.dtc': generateKeyPair() }
    // Recorded (ledgers): a duplicate is refused under the new ledger's `system` key,
    // made before the handle was found taken; it is thrown away with the refusal.
    if (await store.get('', 'ledgers', handle)) {
      req.ledgerKey = keys.system
      throw errors.duplicated('Ledger', handle)
    }
    const record = await create('ledgers', '', keys.system, req)
    // Published newest first on the reference: system, core, system.auth, system.dtc.
    for (const name of ['system.dtc', 'system.auth', 'core', 'system'] as const) {
      await store.putKey(handle, keys[name], name)
      await publishSigner(handle, name, keys[name], keys.system)
    }
    await publishPolicies(record, keys.system)
    reply.status(201).send(record)
  })

  // References between records and what a record of a kind must name (recorded, l5):
  // a bridge must choose one of the ledger's bridge schemas (`rest`), and a wallet's
  // `bridge` must exist. Any record is held to the schema it names, and must name one
  // once a schema for its kind exists (recorded, uschema; `user-schemas.ts`).
  async function related(kind: Kind, scope: string, data: any) {
    if (kind === 'bridges') {
      if (!data.schema) throw new LedgerError(422, 'record.schema-invalid', 'There are schemas defined for record of type bridge, you must specify at least one.')
      const schema = await store.get(scope, 'schemas', data.schema)
      if (!schema || schema.data.record !== 'bridge') throw new LedgerError(422, 'record.relation-not-found', `Referenced Schema ${data.schema} not found.`)
    }
    if (kind === 'wallets' && data.bridge && !(await store.get(scope, 'bridges', data.bridge)))
      throw new LedgerError(422, 'record.relation-not-found', `Referenced Bridge ${data.bridge} not found.`)
    // Recorded (anchors): an anchor names an existing wallet, whatever
    // `anchor.walletRequired` says (the docs make it optional without it).
    if (kind === 'anchors' && !(typeof data.wallet === 'string' && (await store.get(scope, 'wallets', data.wallet))))
      throw new LedgerError(422, 'record.relation-not-found', `Cannot find anchor wallet '${data.wallet}'`)
    if (kind === 'schemas') return checkContent(data.schema)
    if (kind === 'policies' && data.schema === 'processing') validateProcessing(data)
    const record = KINDS[kind].record
    if (typeof data.schema === 'string') {
      const schema = await store.get(scope, 'schemas', data.schema)
      if (!schema || schema.data.record !== record) throw schemaNotFound(data.schema, record)
      validateData(schema.data.schema, data)
    } else if ((await store.list(scope, 'schemas')).some((s) => s.data.record === record)) throw schemaRequired(record)
  }

  // A record a route addresses: `/ledger` is the ledger record itself, stored at the
  // server scope; `/<kind>/:id` is a record inside the ledger.
  type Target = { ledger: StoredRecord; found: StoredRecord; scope: string; kind: Kind }
  async function target(req: FastifyRequest, kind: Kind, id?: string): Promise<Target> {
    if (kind === 'ledgers') {
      const ledger = await hostedLedger(req)
      return { ledger, found: ledger, scope: '', kind }
    }
    const { ledger, found } = await existing(req, kind, id!)
    return { ledger, found, scope: ledger.data.handle, kind }
  }

  async function readable(req: FastifyRequest, kind: Kind, id?: string) {
    const who = await authenticate(req)
    const t = await target(req, kind, id)
    await acl.authorize('read', KINDS[kind].record, { who }, { ledger: t.ledger, record: t.found })
    return t
  }

  async function changeOf(t: Target, n: string) {
    const change = (await store.changes(t.scope, t.kind, keyOf(t.found))).find((c) => String(c.meta.change) === n)
    if (!change) throw errors.changeNotFound()
    return change
  }

  // Access check: the rules that grant an action on this record to the signers of the
  // check request — for reads too. Answered as a list of signed rules without a page,
  // ledger rules first, then the record's own. Observed (records, records2, policies): a
  // rule is shown without its `signer` and `bearer`, a policy as its values, and a record rule without `record` names the record's
  // kind (`{any, signer: A}` on a symbol comes back as `{any, record: symbol}`). Server
  // rules were never listed.
  async function accessCheck(req: FastifyRequest, t: Target) {
    const who = await authenticate(req)
    const record = KINDS[t.kind].record
    // Not even `read` on the record is needed: B, who could not read w2, got `[]` (policies #56).
    const body = req.body as any
    const action = body?.data?.action ?? 'read'
    const matching = await acl.matching(action, record, { who, proofs: proofKeys(body) }, { ledger: t.ledger, record: t.found })
    const shown = [...matching.filter(([, l]) => l === 'ledger'), ...matching.filter(([, l]) => l === 'record')].map(([rule, level]) => {
      const { signer: _s, bearer: _b, ...rest } = rule
      return level === 'record' && rest.record === undefined ? { ...rest, record } : rest
    })
    return envelope(req.ledgerKey, shown.map((rule) => envelope(req.ledgerKey, rule)))
  }

  // Update: a new version whose data names the current hash as `parent`. The record
  // keeps its luid, status and owners; the ledger countersigns with luid only.
  // `finish` sees the new version before it is stored and may replace it (anchor forwarding).
  async function update(req: FastifyRequest, t: Target, finish?: (r: StoredRecord) => Promise<StoredRecord>) {
    validateBody(t.kind as ValidatedKind, req.body)
    const who = await authenticate(req)
    const body = req.body as any
    const keys = await impersonate(body, t.ledger.data.handle, who)
    await acl.authorize('update', KINDS[t.kind].record, { who, proofs: keys }, { ledger: t.ledger, record: t.found })
    if (body.data.parent !== t.found.hash) throw errors.parentHashInvalid()
    if (t.kind !== 'ledgers') await related(t.kind, t.scope, body.data)
    const proofs = await annotate(t.ledger.data.handle, verifyProofs(body))
    const secrets = secretsOf(body.data, body.meta, t.found)
    // Recorded (domains3): a subdomain keeps its parent. The schema refuses `domain` in an
    // update, so the version is sent without it and the ledger puts it back, after the
    // hash was taken (like a ledger's `config` at creation).
    const kept = t.kind === 'domains' && typeof t.found.data.domain === 'string'
    let updated: StoredRecord = {
      hash: body.hash,
      data: kept ? { parent: body.data.parent, handle: body.data.handle, domain: t.found.data.domain, ...body.data } : body.data,
      luid: t.found.luid,
      meta: { ...t.found.meta, proofs: [...proofs, serverProof(body.hash, { luid: t.found.luid, moment: now() }, req.ledgerKey!, 'system')], moment: now() },
    }
    if (finish) updated = await finish(updated)
    await store.update(t.scope, t.kind, updated)
    await keepSecrets(t.scope, t.kind, keyOf(updated), secrets)
    await addChange(t.scope, t.kind, updated, 'update')
    if (t.scope) await raise(t.scope, t.kind, 'updated', { [KINDS[t.kind].record]: updated, parent: t.found }, updated)
    return updated
  }

  // A proof on the current version. With `custom.status` it asks for a status change,
  // which status policies may refuse or leave waiting for a quorum. The ledger appends
  // the proof as sent and does not countersign. On an intent it is a further signature
  // (action `sign`); observed (records2): it is appended, owners stay, and a waiting
  // intent is not processed again.
  // `before` runs once the proof is checked, before it is stored (anchor forwarding).
  async function addProof(req: FastifyRequest, t: Target, before?: (stored: Proof) => Promise<void>) {
    const who = await authenticate(req)
    const record = KINDS[t.kind].record
    // A proof without `public` is a template the token's signer is impersonated on.
    const sent = req.body as any
    const wrapped = { hash: t.found.hash, data: t.found.data, meta: { proofs: sent && !sent.public ? [sent] : [] } }
    const keys = wrapped.meta.proofs.length ? await impersonate(wrapped, t.ledger.data.handle, who) : sent?.public ? [sent.public] : []
    const proof: any = wrapped.meta.proofs.at(-1) ?? sent
    // On an intent, adding a proof is `create` of an `intent-proof` (recorded, bproofs):
    // `{any, record: intent}` does not grant it, nor any rule on the bridge whose entry
    // the proof reports on (about-intents says `sign` there, which is no action). Who may
    // add one may also report an entry: a bridge's own key is not required.
    const [action, kind] = t.kind === 'intents' ? ['create', 'intent-proof'] : ['update', record]
    const scope = { ledger: t.ledger, record: t.found }
    await acl.authorize(action, kind, { who, proofs: keys.filter(Boolean) }, scope).catch(async (e) => {
      throw t.kind === 'intents' && e instanceof LedgerError && e.reason === 'auth.forbidden' ? errors.proofForbidden(await acl.signerMisses(action, kind, scope)) : e
    })
    if (!proof?.digest || !proof?.public || !proof?.result) throw errors.signatureMissing()
    if (proof.digest !== digestFor(t.found.hash, proof.custom) || !verifyDigest(proof.digest, proof.public, proof.result))
      throw errors.signatureInvalid(proof.public)
    if (t.kind === 'reports') validateReportProof(sent)
    const [stored] = await annotate(t.ledger.data.handle, [proof])
    await before?.(stored)
    // Intents are also written by the core; append under the ledger's lock.
    let dropped = false
    let parent: StoredRecord | undefined
    return store.transaction(t.ledger.data.handle, async (tx) => {
      const current = (await tx.get(t.scope, t.kind, keyOf(t.found))) ?? t.found
      if (t.kind === 'intents') parent = structuredClone(current)
      const status = stored.custom?.status
      // A report's status moves along its table; a proof repeating it is dropped (reports.ts).
      if (t.kind === 'reports' && typeof status === 'string' && !statusChange(String(current.meta.status), status)) {
        dropped = true
        return current
      }
      if (t.kind === 'reports' && status === 'completed' && stored.custom?.assets !== undefined) {
        checkAssets(stored.custom.assets, reports.bucket)
        current.meta = { assets: stored.custom.assets, ...current.meta }
      }
      // An intent's status belongs to its processing: a participant's report (which
      // carries a status) is appended and read by the core, never applied here. A late
      // duplicate `committed` must not move a completed intent back.
      if (t.kind === 'intents') current.meta.proofs.push(stored)
      else await applyStatus(tx, acl, t.ledger, record, current, stored)
      await tx.update(t.scope, t.kind, current)
      const n = (await tx.changes(t.scope, t.kind, keyOf(current))).length + 1
      await tx.addChange(t.scope, t.kind, keyOf(current), snapshot(current, n, 'update', now(), t.kind !== 'anchors'))
      return current
    }).then(async (current) => {
      if (dropped) return current
      if (t.scope) await raise(t.scope, t.kind, 'proofs-added', { proofs: [stored], [record]: keyOf(current) }, current)
      // Recorded (signals2): a proof on an intent is also a new version of it, the one
      // before as `parent`; both as stored, `domains` included (the core leaves it out).
      if (t.scope && parent) await raise(t.scope, t.kind, 'updated', { intent: intentVersion(current), parent: intentVersion(parent) }, current)
      // A participant reporting on an entry (`custom.handle`) may let the intent move on.
      if (t.kind === 'intents' && typeof stored.custom?.handle === 'string') core.schedule(t.scope, current.data.handle)
      return current
    })
  }

  app.get('/api/v2/ledger', async (req) => (await readable(req, 'ledgers')).found)
  app.put('/api/v2/ledger', async (req) => update(req, await target(req, 'ledgers')))
  app.post('/api/v2/ledger/proofs', async (req) => addProof(req, await target(req, 'ledgers')))
  app.get('/api/v2/ledger/changes', async (req) => {
    const t = await readable(req, 'ledgers')
    return changePage(req, t.scope, t.kind, keyOf(t.found))
  })
  app.get<{ Params: { change: string } }>('/api/v2/ledger/changes/:change', async (req) => changeOf(await readable(req, 'ledgers'), req.params.change))
  app.post('/api/v2/ledger/access/!check', async (req) => accessCheck(req, await target(req, 'ledgers')))

  // ---- the ledger collection (recorded, ledgers) ---------------------------------------

  // A signer sees the ledgers it owns (signed at creation), newest first; a stranger an
  // empty page, anonymous callers nothing. The route belongs to the server, not to a ledger.
  app.get('/api/v2/ledgers', async (req) => {
    if (req.headers['x-ledger']) throw errors.noTenantAllowed()
    const who = await authenticate(req)
    if (!who) throw errors.forbidden('query', 'ledger')
    const owned = (await store.list('', 'ledgers')).filter((l) => ((l.meta.owners as string[] | undefined) ?? []).includes(who.public))
    return listPage(req, owned)
  })

  // Drop of a whole ledger. The reference validates the body (a `luid` is required) and
  // then has no such route; `POST /ledger` is not routed there at all. With
  // `ledgerDrop` on, the rules decide (`drop` on `ledger`), the parent hash must be the
  // ledger's, and everything of the ledger is forgotten (store.dropLedger).
  async function activeLedger(req: FastifyRequest) {
    if (!req.headers['x-ledger']) throw errors.ledgerNotSet()
    return hostedLedger(req)
  }
  async function dropLedger(req: FastifyRequest, reply: FastifyReply) {
    const ledger = await activeLedger(req)
    validateLedgerDrop(req.body)
    if (!ledgerDrop) throw errors.routeNotFound()
    const who = await authenticate(req)
    const body = req.body as any
    const keys = await impersonate(body, ledger.data.handle, who, 'dropped')
    await acl.authorize('drop', 'ledger', { who, proofs: keys }, { ledger, record: ledger })
    if (body.luid !== ledger.luid || body.data.parent !== ledger.hash) throw errors.parentHashInvalid()
    verifyProofs(body)
    await store.dropLedger(ledger.data.handle)
    reply.status(204).send()
  }
  app.delete('/api/v2/ledger', dropLedger)
  app.post('/api/v2/ledger', async (req, reply) => {
    if (ledgerDrop) return dropLedger(req, reply)
    // Express's own answer for a route it does not have.
    reply.status(404).header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'").header('x-content-type-options', 'nosniff')
    return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot POST /v2/ledger</pre>\n</body>\n</html>\n`
  })

  // ---- the request journal (journal.ts) ------------------------------------------------

  const JOURNAL = '/api/v2/system/requests'
  const journalWrites = new Map<string, Promise<unknown>>()
  async function journalOf(req: FastifyRequest) {
    const ledger = await activeLedger(req)
    if (!journal) throw errors.routeNotFound('Journaling is not enabled')
    const who = await authenticate(req)
    await acl.authorize('read', 'request', { who }, { ledger })
    await journalWrites.get(ledger.data.handle)
    return ledger
  }
  app.get(JOURNAL, async (req) => listPage(req, await store.list((await journalOf(req)).data.handle, 'requests')))
  app.get<{ Params: { id: string } }>(`${JOURNAL}/:id`, async (req) => {
    const scope = (await journalOf(req)).data.handle
    const id = req.params.id
    const found = id.startsWith('$req.') ? await store.getByLuid(scope, 'requests', id) : await store.get(scope, 'requests', id)
    if (!found) throw errors.notFound('Request')
    return found
  })

  // Every request to a hosted ledger, except reads of the journal itself. The entry is
  // written behind the answer (a hook that waited would race handlers that send
  // themselves); a read of the journal first waits for the writes still under way.
  if (journal) {
    app.addHook('onSend', (req, reply, payload, done) => {
      const scope = req.headers['x-ledger']
      if (typeof scope !== 'string' || !req.ledgerKey || req.url.startsWith(JOURNAL) || (req as any).journaled) return done(null, payload)
      ;(req as any).journaled = true
      const result = { status: reply.statusCode, headers: redact(reply.getHeaders() as Record<string, unknown>), body: typeof payload === 'string' ? payload : '' }
      const write = (journalWrites.get(scope) ?? Promise.resolve()).then(() => journalEntry(req, scope, result)).catch((e) => console.error('journal:', e))
      journalWrites.set(scope, write)
      done(null, payload)
    })
  }
  async function journalEntry(req: FastifyRequest, scope: string, result: Record<string, unknown>) {
    if (!(await store.get('', 'ledgers', scope))) return
    const who = await authenticate(req).catch(() => undefined)
    const signer = who && (who.signer ?? (await signerByKey(scope, who.public)))
    const moment = now()
    const data = {
      handle: newLuid('').slice(2),
      schema: 'rest',
      ...describe(req.method, req.url),
      source: who ? `signer:${signer ?? who.public}` : 'unknown',
      target: `ledger:${scope}`,
      params: { method: req.method, url: `${publicBase(req)}${req.url.replace(/^\/api\/v2/, '')}`, headers: redact(req.headers), body: req.body === undefined ? '' : JSON.stringify(req.body), moment },
      result,
    }
    const hash = hashData(data)
    const luid = newLuid('$req')
    const proof = serverProof(hash, { luid, moment, status: 'created' }, req.ledgerKey!, 'system')
    await store.insert(scope, 'requests', { luid, hash, data, meta: { status: 'created', moment, owners: [], proofs: [proof] } } as StoredRecord)
  }

  // ---- anchor forwarding (forwarding.ts; recorded, forwarding) ----------------------

  // What the ledger sends is the client's body (or the record it is about to keep) with
  // the ledger's proof appended: `{moment, status}` for creates and drops, `{moment}`
  // for updates; a proof goes as the ledger stores it. Local checks come first: a
  // duplicate is refused without a call.
  const forwarded = (req: FastifyRequest, ledger: StoredRecord, aspect: Aspect, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, list = false) =>
    forward({ ledger: ledger.data.handle, key: req.ledgerKey!, bridge: aspect.bridge, method, path, body, client: req.headers.authorization }, list)
  const countersigned = (req: FastifyRequest, body: any, custom: Record<string, unknown>) => ({
    ...body,
    meta: { ...body.meta, proofs: [...(body.meta?.proofs ?? []), serverProof(body.hash, { moment: now(), ...custom }, req.ledgerKey!, 'system')] },
  })
  const anchorPath = (id: string) => `/${encodeURIComponent(id)}`
  const anchorAspect = async (req: FastifyRequest, action: Action) => {
    const ledger = await hostedLedger(req)
    return { ledger, aspect: await aspectFor(store, ledger.data.handle, action) }
  }

  // The ledger draws a luid for what it sends; validate keeps the record under another
  // (recorded). Synchronize keeps what the bridge answered, under a luid drawn again.
  async function createAnchor(req: FastifyRequest, ledger: StoredRecord, aspect: Aspect) {
    const body = req.body as any
    const scope = ledger.data.handle
    verifyProofs(body)
    if (aspect.strategy !== 'proxy' && (await store.get(scope, 'anchors', body.data.handle))) throw errors.duplicated('Anchor', body.data.handle)
    const sent = { ...countersigned(req, body, { status: 'created' }), luid: newLuid('$anc') }
    if (aspect.strategy === 'proxy') return forwarded(req, ledger, aspect, 'POST', '', sent)
    if (aspect.strategy === 'validate') {
      await forwarded(req, ledger, aspect, 'POST', '', sent)
      return create('anchors', scope, req.ledgerKey!, req)
    }
    return create('anchors', scope, req.ledgerKey!, req, async (r) => {
      const answer = await forwarded(req, ledger, aspect, 'POST', '', countersigned(req, r, { status: 'created' }))
      return { hash: answer.hash, data: answer.data, luid: newLuid('$anc'), meta: { ...r.meta, proofs: answer.meta.proofs, moment: now() } }
    })
  }

  // Proxy answers the bridge's record as it is; fallback the ledger's own when it has it.
  async function readAnchor(req: FastifyRequest, id: string) {
    const { ledger, aspect } = await anchorAspect(req, 'read')
    if (!aspect || (aspect.strategy === 'fallback' && (await find(ledger.data.handle, 'anchors', id)))) return (await readable(req, 'anchors', id)).found
    const who = await authenticate(req)
    await acl.authorize('read', 'anchor', { who }, { ledger })
    return forwarded(req, ledger, aspect, 'GET', anchorPath(id))
  }

  // The bridge's list is asked for without the query, and comes back with its proofs and the ledger's.
  async function listAnchors(req: FastifyRequest, local: () => ReturnType<typeof listPage>) {
    const { ledger, aspect } = await anchorAspect(req, 'query')
    if (!aspect) return local()
    if (aspect.strategy === 'fallback') {
      const page = local()
      if ((page.data as unknown[]).length) return page
    }
    const answer = await forwarded(req, ledger, aspect, 'GET', '', undefined, true)
    return { hash: answer.hash, data: answer.data, meta: { proofs: [...(answer.meta?.proofs ?? []), serverProof(answer.hash, { moment: now() }, req.ledgerKey!, 'system')] } }
  }

  async function updateAnchor(req: FastifyRequest, id: string) {
    const { ledger, aspect } = await anchorAspect(req, 'update')
    if (!aspect || aspect.strategy !== 'proxy') {
      const t = await target(req, 'anchors', id)
      if (!aspect) return update(req, t)
      if (aspect.strategy === 'validate')
        return update(req, t, async (r) => {
          await forwarded(req, ledger, aspect, 'PUT', anchorPath(id), countersigned(req, req.body, {}))
          return r
        })
      return update(req, t, async (r) => {
        const answer = await forwarded(req, ledger, aspect, 'PUT', anchorPath(id), countersigned(req, r, {}))
        return { ...r, hash: answer.hash, data: answer.data, meta: { ...r.meta, proofs: answer.meta.proofs, moment: now() } }
      })
    }
    validateBody('anchors', req.body)
    const who = await authenticate(req)
    const keys = await impersonate(req.body, ledger.data.handle, who)
    await acl.authorize('update', 'anchor', { who, proofs: keys }, { ledger })
    verifyProofs(req.body)
    return forwarded(req, ledger, aspect, 'PUT', anchorPath(id), countersigned(req, req.body, {}))
  }

  // Signing under synchronize is a 500 on the reference (a bug, divergences.json); here
  // it is validate's: the bridge accepts the proof, then the ledger adds it.
  async function signAnchor(req: FastifyRequest, id: string) {
    const { ledger, aspect } = await anchorAspect(req, 'sign')
    if (aspect?.strategy !== 'proxy') {
      const t = await target(req, 'anchors', id)
      return addProof(req, t, aspect && (async (stored) => void (await forwarded(req, ledger, aspect, 'POST', `${anchorPath(id)}/proofs`, stored))))
    }
    const who = await authenticate(req)
    const sent = req.body as any
    const keys = sent?.public ? [sent.public] : await impersonate({ hash: '', data: {}, meta: { proofs: [sent] } }, ledger.data.handle, who)
    await acl.authorize('update', 'anchor', { who, proofs: keys }, { ledger })
    const [stored] = await annotate(ledger.data.handle, [sent])
    return forwarded(req, ledger, aspect, 'POST', `${anchorPath(id)}/proofs`, stored)
  }

  // ---- records -------------------------------------------------------------------

  for (const kind of TOP_LEVEL) {
    const record = KINDS[kind].record
    type P = { Params: { id: string } }

    app.post(`/api/v2/${kind}`, async (req, reply) => {
      validateBody(kind as ValidatedKind, req.body)
      const who = await authenticate(req)
      const ledger = await hostedLedger(req)
      const keys = await impersonate(req.body, ledger.data.handle, who, 'created')
      // A record is judged by the domain it joins (domains2); a subdomain by the ledger's rules alone.
      const domain = kind === 'domains' ? undefined : await joining(ledger.data.handle, req.body)
      await acl.authorize('create', record, { who, proofs: keys }, { ledger, domain })
      await related(kind, ledger.data.handle, (req.body as any).data)
      const aspect = kind === 'anchors' ? await aspectFor(store, ledger.data.handle, 'create') : undefined
      reply.status(201).send(aspect ? await createAnchor(req, ledger, aspect) : await create(kind, ledger.data.handle, req.ledgerKey!, req))
    })

    app.get(`/api/v2/${kind}`, async (req) => {
      const who = await authenticate(req)
      const ledger = await hostedLedger(req)
      const unsupported = unsupportedFilters(kind, req.query as Record<string, unknown>)
      if (unsupported.length) throw new LedgerError(400, 'api.query-malformed', `Unsupported filters: ${unsupported.map((f) => `'${f}'`).join(', ')}`)
      // The reference answers a `meta.moment` that is no date with a 500 (a failed SQL cast).
      const moment = (req.query as Record<string, unknown>)['meta.moment']
      if (typeof moment === 'string' && Number.isNaN(Date.parse(moment)))
        throw new LedgerError(400, 'api.query-malformed', `Invalid date in filter 'meta.moment': '${moment}'`)
      await acl.authorizeQuery(record, { who }, { ledger })
      const rows: StoredRecord[] = []
      for (const r of await store.list(ledger.data.handle, kind)) if (await acl.allowed('read', record, { who }, { ledger, record: r })) rows.push(r)
      return kind === 'anchors' ? listAnchors(req, () => listPage(req, rows)) : listPage(req, rows)
    })

    app.get<P>(`/api/v2/${kind}/:id`, async (req) => (kind === 'anchors' ? readAnchor(req, req.params.id) : (await readable(req, kind, req.params.id)).found))
    app.get<P>(`/api/v2/${kind}/:id/changes`, async (req) => {
      const t = await readable(req, kind, req.params.id)
      return changePage(req, t.scope, kind, keyOf(t.found))
    })
    app.get<{ Params: { id: string; change: string } }>(`/api/v2/${kind}/:id/changes/:change`, async (req) =>
      changeOf(await readable(req, kind, req.params.id), req.params.change),
    )
    app.post<P>(`/api/v2/${kind}/:id/access/!check`, async (req) => accessCheck(req, await target(req, kind, req.params.id)))
    app.post<P>(`/api/v2/${kind}/:id/proofs`, async (req) => (kind === 'anchors' ? signAnchor(req, req.params.id) : addProof(req, await target(req, kind, req.params.id))))
    if ((MUTABLE as readonly string[]).includes(kind))
      app.put<P>(`/api/v2/${kind}/:id`, async (req) => (kind === 'anchors' ? updateAnchor(req, req.params.id) : update(req, await target(req, kind, req.params.id))))
  }

  // ---- wallets -------------------------------------------------------------------

  // Drop: signed like an update (data.parent = current hash), 204, then gone (a read
  // is 404). What may not be dropped (recorded): a wallet that still holds a balance,
  // a bridge a wallet names (`drops`). System policies may be (`drops`).
  type DropParams = { Params: { id: string; signer?: string } }
  const dropOf = (kind: 'wallets' | 'effects' | 'bridges' | 'policies' | 'anchors' | 'factors' | 'reports', guard?: (scope: string, found: StoredRecord, req: FastifyRequest<DropParams>) => Promise<void>) =>
    async (req: FastifyRequest<DropParams>, reply: FastifyReply) => {
      validateBody('drop', req.body)
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      const body = req.body as any
      const keys = await impersonate(req.body, ledger.data.handle, who, 'dropped')
      await acl.authorize('drop', KINDS[kind].record, { who, proofs: keys }, { ledger, record: found })
      if (body.data.parent !== found.hash) throw errors.parentHashInvalid()
      verifyProofs(body)
      await guard?.(ledger.data.handle, found, req)
      await store.remove(ledger.data.handle, kind, found.data.handle)
      if (kind === 'effects' || kind === 'factors' || kind === 'reports') await raise(ledger.data.handle, kind, 'dropped', { [KINDS[kind].record]: found }, found)
      reply.status(204).send()
    }
  const drops = {
    wallets: dropOf('wallets', async (scope, found) => {
      const held = (await store.balances(scope, found.data.handle)).filter((b) => b.data.amount !== 0)
      // Recorded (waits): the symbols still held are named.
      if (held.length)
        throw new LedgerError(422, 'record.drop-rejected', `Cannot drop wallet '${found.data.handle}' with balance different from zero`, {
          symbols: [...new Set(held.map((b) => b.data.symbol))],
        })
      // Recorded (anchors, with `anchor.walletRequired` on): the anchors are named.
      const anchors = (await store.list(scope, 'anchors')).filter((a) => a.data.wallet === found.data.handle)
      if (anchors.length)
        throw new LedgerError(422, 'record.drop-rejected', `Cannot drop wallet '${found.data.handle}' with anchors associated with it`, {
          // By luid, as the reference (anchors, routes2); its luids are random within a second.
          anchors: anchors.sort((a, b) => (a.luid < b.luid ? -1 : a.luid > b.luid ? 1 : 0)).map((a) => a.data.handle),
        })
    }),
    bridges: dropOf('bridges', async (scope, found) => {
      if ((await store.list(scope, 'wallets')).some((w) => w.data.bridge === found.data.handle))
        throw errors.dropRejected(`Bridge ${found.data.handle} is in use by wallets. Please remove it from the wallets first.`)
    }),
    policies: dropOf('policies'),
    // Forwarded (forwarding.ts): proxy needs no local anchor; validate drops it once the bridge did.
    anchors: async (req: FastifyRequest<DropParams>, reply: FastifyReply) => {
      const { ledger, aspect } = await anchorAspect(req, 'drop')
      const send = () => forwarded(req, ledger, aspect!, 'DELETE', anchorPath(req.params.id), countersigned(req, req.body, { status: 'dropped' }))
      if (aspect?.strategy !== 'proxy') return dropOf('anchors', aspect && (async () => void (await send())))(req, reply)
      validateBody('drop', req.body)
      const who = await authenticate(req)
      const keys = await impersonate(req.body, ledger.data.handle, who, 'dropped')
      await acl.authorize('drop', 'anchor', { who, proofs: keys }, { ledger })
      verifyProofs(req.body)
      await send()
      reply.status(204).send()
    },
    effects: dropOf('effects'),
    reports: dropOf('reports'),
  }
  for (const [kind, handler] of Object.entries(drops)) {
    app.delete<{ Params: { id: string } }>(`/api/v2/${kind}/:id`, handler)
    app.post<{ Params: { id: string } }>(`/api/v2/${kind}/:id/drop`, handler)
  }

  // ---- report assets (reports.ts) ------------------------------------------------------

  // The SDK's `report.downloadAsset` (not in the spec): the file as an attachment named
  // by the asset's handle. The reference answers an unknown asset, and a report without
  // assets, with a 500, and fails outright on a file missing from its bucket; we answer 404.
  app.get<{ Params: { id: string; asset: string } }>('/api/v2/reports/:id/assets/:asset', async (req, reply) => {
    const { found } = await readable(req, 'reports', req.params.id)
    const asset = (found.meta.assets as { handle: string; output: string }[] | undefined)?.find((a) => a.handle === req.params.asset)
    if (!asset) throw new LedgerError(404, 'record.not-found', `Asset ${req.params.asset} not found`)
    const file = reports.dir && resolve(reports.dir, objectPath(asset.output))
    if (!file || !file.startsWith(resolve(reports.dir!) + sep) || !existsSync(file))
      throw new LedgerError(404, 'record.not-found', `Asset ${asset.handle} is not stored on this server`)
    reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${asset.handle}"`)
    return reply.send(createReadStream(file))
  })


  // ---- signer factors (recorded, factors) ----------------------------------------------

  // A factor (`$snf`) is a record of the ledger under its signer, `data.signer`, with
  // the generic lifecycle. A path naming another signer than the factor's is
  // `record.invalid`. What differs from other records (recorded):
  // - a key pair without `secret` is served with `secret: null`, outside its hash and
  //   not in its changes (like a ledger's `config`);
  // - an `oauth-client-credentials` factor gets a generated `clientId` and
  //   `clientSecret` (a sealed secret); its data is re-hashed, the client's proofs are
  //   dropped, and it has no status and no owners;
  // - `?include=meta.secret` serves the secrets in the clear, the private key of a key
  //   pair included. We ask `read` on `signer-factor-secret` for it (the access record
  //   type exists for this; the reference's rule for it was not recorded).
  // Lists come with `total: 0`. A dropped factor is gone, its changes too (404 by luid).
  type FP = { Params: { signer: string; id: string } }
  const signerMismatch = () => new LedgerError(422, 'record.invalid', 'Signer in the request does not match the signer in the data')
  const factorNotFound = () => new LedgerError(404, 'record.not-found', 'Signerfactor not found')

  async function factorTarget(req: FastifyRequest<FP>, read = false): Promise<Target> {
    const t = await (read ? readable(req, 'factors', req.params.id) : target(req, 'factors', req.params.id)).catch((e) => {
      throw e instanceof LedgerError && e.status === 404 ? factorNotFound() : e
    })
    if (t.found.data.signer !== req.params.signer) throw signerMismatch()
    return t
  }

  const servedFactor = (r: StoredRecord): StoredRecord =>
    r.data.schema === 'key-pair' && !('secret' in r.data) ? { ...r, data: { ...r.data, secret: null } } : r

  const wantsSecrets = (req: FastifyRequest) =>
    Object.entries((req.query as Record<string, unknown>) ?? {}).some(([k, v]) => k.startsWith('include') && [v].flat().includes('meta.secret'))

  async function openSecret(scope: string, handle: string, name: string) {
    const at = `signer-factor/${handle}/${name}`
    const sealed = await store.getSecret(scope, at)
    return sealed === undefined ? undefined : core.secrets.open(sealed, `${scope}/${at}`)
  }

  async function presentFactor(req: FastifyRequest, ledger: StoredRecord, r: StoredRecord, who?: Principal) {
    const out = servedFactor(r)
    if (!wantsSecrets(req)) return out
    await acl.authorize('read', 'signer-factor-secret', { who }, { ledger, record: r })
    const secret: Record<string, string> = {}
    for (const name of secretRefs(r.data)) {
      const value = await openSecret(ledger.data.handle, r.data.handle, name)
      if (value !== undefined) secret[name] = value
    }
    return { ...out, meta: { ...out.meta, secret } }
  }

  // Credentials are the ledger's to make unless the ledger allows clients to bring
  // their own (`signer.factor.oauth.allowClientCredentials`; then a secret comes as
  // `{{ secret.clientSecret }}` with its value in `meta.secret`).
  async function createOauthFactor(ledger: StoredRecord, key: KeyPair, req: FastifyRequest) {
    const body = req.body as any
    const scope = ledger.data.handle
    verifyProofs(body)
    const own = body.data.clientId !== undefined || body.data.clientSecret !== undefined
    if (own && ledger.data.config?.['signer.factor.oauth.allowClientCredentials'] !== true)
      throw new LedgerError(
        422,
        'record.invalid',
        'Providing clientId or clientSecret is not allowed. Leave the fields blank and ledger will generate the credentials instead.Enable the signer.factor.oauth.allowClientCredentials flag to use be able to provide credentials.',
      )
    const given = secretsOf(body.data, body.meta)
    const clientSecret = given.find(([n]) => n === 'clientSecret')?.[1] ?? randomBytes(32).toString('base64url')
    const { handle, schema, signer, clientId: _id, clientSecret: _secret, ...rest } = body.data
    const data = { handle, schema, signer, clientId: body.data.clientId ?? customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', 22)(), clientSecret: '{{ secret.clientSecret }}', ...rest }
    const hash = hashData(data)
    const luid = newLuid('$snf')
    const moment = now()
    const record: StoredRecord = { hash, data, luid, meta: { proofs: [serverProof(hash, { luid, moment: now() }, key, 'system')], moment, owners: [] } }
    if (!(await store.insert(scope, 'factors', record))) throw errors.duplicated(KINDS.factors.name, handle)
    await keepSecrets(scope, 'factors', handle, [...given.filter(([n]) => n !== 'clientSecret'), ['clientSecret', clientSecret]])
    await addChange(scope, 'factors', record, 'create')
    await raise(scope, 'factors', 'created', { 'signer-factor': record }, record)
    return record
  }

  app.post<{ Params: { signer: string } }>('/api/v2/signers/:signer/factors', async (req, reply) => {
    validateBody('factors', req.body)
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    const scope = ledger.data.handle
    const data = (req.body as any).data
    if (data.signer !== req.params.signer) throw signerMismatch()
    if (!(await store.get(scope, 'signers', data.signer))) throw new LedgerError(422, 'record.relation-not-found', `Referenced Signer ${data.signer} not found.`)
    const keys = await impersonate(req.body, scope, who, 'created')
    await acl.authorize('create', 'signer-factor', { who, proofs: keys }, { ledger })
    await related('factors', scope, data)
    const record = data.schema === 'oauth-client-credentials' ? await createOauthFactor(ledger, req.ledgerKey!, req) : await create('factors', scope, req.ledgerKey!, req)
    reply.status(201).send(await presentFactor(req, ledger, record, who))
  })

  app.get<{ Params: { signer: string } }>('/api/v2/signers/:signer/factors', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    await acl.authorize('read', 'signer-factor', { who }, { ledger })
    const rows = (await store.list(ledger.data.handle, 'factors')).filter((f) => f.data.signer === req.params.signer).map(servedFactor)
    const page = listPage(req, rows) as ReturnType<typeof listPage> & { page: object }
    return { ...page, page: { ...page.page, total: 0 } }
  })

  app.get<FP>('/api/v2/signers/:signer/factors/:id', async (req) => {
    const t = await factorTarget(req, true)
    return presentFactor(req, t.ledger, t.found, await authenticate(req))
  })
  app.put<FP>('/api/v2/signers/:signer/factors/:id', async (req) => {
    const t = await factorTarget(req)
    if ((req.body as any)?.data?.signer !== undefined && (req.body as any).data.signer !== req.params.signer) throw signerMismatch()
    return servedFactor(await update(req, t))
  })
  app.post<FP>('/api/v2/signers/:signer/factors/:id/proofs', async (req) => servedFactor(await addProof(req, await factorTarget(req))))
  app.post<FP>('/api/v2/signers/:signer/factors/:id/access/!check', async (req) => accessCheck(req, await factorTarget(req)))
  app.get<FP>('/api/v2/signers/:signer/factors/:id/changes', async (req) => {
    const t = await factorTarget(req, true)
    return changePage(req, t.scope, 'factors', keyOf(t.found))
  })
  app.get<{ Params: { signer: string; id: string; change: string } }>('/api/v2/signers/:signer/factors/:id/changes/:change', async (req) => {
    const t = await factorTarget(req, true)
    const change = (await store.changes(t.scope, 'factors', keyOf(t.found))).find((c) => String(c.meta.change) === req.params.change)
    if (!change) throw new LedgerError(404, 'record.not-found', 'Signer factor change not found')
    return change
  })
  const dropFactor = dropOf('factors', async (_scope, found, req) => {
    if (found.data.signer !== req.params.signer) throw signerMismatch()
  })
  app.delete<FP>('/api/v2/signers/:signer/factors/:id', dropFactor)
  app.post<FP>('/api/v2/signers/:signer/factors/:id/drop', dropFactor)

  // ---- OAuth 2.0 client credentials (authenticate-with-oauth; recorded, oauth) --------

  // RFC 6749 §4.4 on the ledger: Basic `clientId:clientSecret` (or form fields) for an
  // `oauth-client-credentials` factor, answered with an RS256 JWT signed by the private
  // key of the provider's key-pair factor (`kid` = its handle). Claims as recorded:
  // `iss` provider, `cid` factor, `sub` the factor's signer, `aud` the server's public
  // address, `exp` = `iat` + `jwt.ttl` (3600). Answers and errors are plain RFC 6749
  // JSON, unsigned. Checked in this order (recorded): grant type present, supported,
  // credentials given; then an authentication policy, then the credentials. A value's
  // `target.schema` restricts it to signers of that schema.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  )
  app.post('/api/v2/oauth/token', async (req, reply) => {
    const fail = (status: number, error: string, error_description: string) => reply.status(status).send({ error, error_description })
    const form = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, string | undefined>
    if (!form.grant_type) return fail(400, 'invalid_request', 'The request is missing a required parameter: grant_type')
    if (form.grant_type !== 'client_credentials') return fail(400, 'unsupported_grant_type', 'The authorization grant type is not supported. Expected: client_credentials')
    let id = form.client_id
    let secret = form.client_secret
    const basic = req.headers.authorization
    if (basic?.startsWith('Basic ')) {
      const raw = Buffer.from(basic.slice(6), 'base64').toString('utf8')
      const at = raw.indexOf(':')
      if (at >= 0) [id, secret] = [raw.slice(0, at), raw.slice(at + 1)]
    }
    if (!id || !secret)
      return fail(400, 'invalid_request', 'Client credentials must be provided either via Basic authentication or as client_id and client_secret in the request body.')
    const ledger = await hostedLedger(req)
    const scope = ledger.data.handle
    const providers = await oauthProviders(scope)
    if (!providers.length) return fail(400, 'invalid_grant', 'OAuth is not enabled for this ledger')
    const factors = await store.list(scope, 'factors')
    const factor = factors.find((f) => f.data.schema === 'oauth-client-credentials' && f.data.clientId === id)
    const stored = factor && (await openSecret(scope, factor.data.handle, 'clientSecret'))
    const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
    if (!factor || stored === undefined || !same(stored, secret)) return fail(401, 'invalid_client', 'Invalid client credentials')
    const subject = await store.get(scope, 'signers', factor.data.signer)
    const value = providers.find((v) => !v.target?.schema || v.target.schema === subject?.data.schema)
    if (!value) return fail(401, 'invalid_client', 'Invalid client credentials')
    const signing = factors.find((f) => f.data.signer === value.signer.handle && f.data.schema === 'key-pair' && secretRefs(f.data).size)
    const pem = signing && (await openSecret(scope, signing.data.handle, [...secretRefs(signing.data)][0]))
    if (!signing || !pem) return fail(500, 'server_error', 'An unexpected error occurred processing the request')
    const ttl = Number(value.config?.['jwt.ttl'] ?? 3600)
    const iat = Math.floor(Date.now() / 1000)
    const access_token = await new SignJWT({ iss: value.signer.handle, cid: factor.data.handle, sub: factor.data.signer, aud: publicBase(req), iat, exp: iat + ttl })
      .setProtectedHeader({ alg: 'RS256', kid: signing.data.handle })
      .sign(createPrivateKey(pem))
    return { access_token, token_type: 'Bearer', expires_in: ttl }
  })

  // ---- event deliveries (inspect-event-deliveries; recorded in `events`, `effects`) --

  // Every call to a bridge or an effect's target is a delivery record (`$evd`,
  // core.ts), linked to its bridge or effect by `data.bridge` / `data.effect`. Listing
  // needs `query-event` on the owner, retrying `retry-event`; lists take the usual
  // filters (`meta.status`, `data.linked`) and come newest first.
  for (const kind of ['bridges', 'effects'] as const) {
    const record = KINDS[kind].record
    type E = { Params: { id: string; delivery: string } }
    const deliveriesOf = async (t: Target) => (await store.list(t.scope, 'events')).filter((d) => d.data[record] === t.found.data.handle)
    app.get<{ Params: { id: string } }>(`/api/v2/${kind}/:id/events`, async (req) => {
      const who = await authenticate(req)
      const t = await target(req, kind, req.params.id)
      await acl.authorize('query-event', record, { who }, { ledger: t.ledger, record: t.found })
      return listPage(req, await deliveriesOf(t))
    })
    app.get<E>(`/api/v2/${kind}/:id/events/:delivery`, async (req) => {
      const who = await authenticate(req)
      const t = await target(req, kind, req.params.id)
      await acl.authorize('query-event', record, { who }, { ledger: t.ledger, record: t.found })
      const found = (await deliveriesOf(t)).find((d) => d.data.handle === req.params.delivery)
      if (!found) throw new LedgerError(404, 'record.not-found', `Event delivery '${req.params.delivery}' not found on ledger '${t.scope}'`)
      return found
    })
    // 202 with no body; the deliveries go out in the background.
    app.post<{ Params: { id: string } }>(`/api/v2/${kind}/:id/events/retry`, async (req, reply) => {
      const who = await authenticate(req)
      const t = await target(req, kind, req.params.id)
      verifyProofs(req.body)
      await acl.authorize('retry-event', record, { who, proofs: proofKeys(req.body) }, { ledger: t.ledger, record: t.found })
      const data = ((req.body as any)?.data ?? {}) as { handle?: string; maxAge?: number }
      const by = data.handle !== undefined ? { handle: String(data.handle) } : { maxAge: typeof data.maxAge === 'number' ? data.maxAge : undefined }
      if (!(await core.retryDeliveries(t.scope, record, t.found.data.handle, by)))
        throw new LedgerError(404, 'record.not-found', `Event '${data.handle}' not found on ledger '${t.scope}'`)
      reply.status(202).send()
    })

    // The deprecated form of a bulk retry (spec: activateBridge, activateEffect;
    // recorded, secure): signed `{maxAge}`, access `activate`, 202 with no body. It
    // resends cancelled deliveries too.
    app.post<{ Params: { id: string } }>(`/api/v2/${kind}/:id/activate`, async (req, reply) => {
      const who = await authenticate(req)
      const t = await target(req, kind, req.params.id)
      verifyProofs(req.body)
      await acl.authorize('activate', record, { who, proofs: proofKeys(req.body) }, { ledger: t.ledger, record: t.found })
      const maxAge = (req.body as any)?.data?.maxAge
      await core.retryDeliveries(t.scope, record, t.found.data.handle, { maxAge: typeof maxAge === 'number' ? maxAge : undefined })
      reply.status(202).send()
    })
  }

  // Anchors and domains of a wallet (recorded, anchors2). When the address resolves
  // to a wallet whose bridge has the trait, the bridge answers instead of the ledger:
  // `GET {server}/wallets/<address>/anchors|domains`, or `POST …/anchors/!lookup` with
  // the request's data signed by the ledger, sent with the client's own token. It returns a signed
  // list of records' data; each comes back as `{data: {access: [], …}, meta: {}}`.
  // Otherwise the ledger answers from its own anchors (`data.wallet`); it holds no
  // domains for a wallet. A signed list without `page` either way.
  async function fromBridge(req: FastifyRequest, scope: string, address: string, what: 'anchors' | 'domains', lookup?: any) {
    const wallet = await resolveAddress(store, scope, address)
    const bridge = wallet?.data.bridge ? await store.get(scope, 'bridges', wallet.data.bridge) : undefined
    if (!bridge || !hasTrait(bridge.data, what, lookup?.data ?? { wallet: address })) return undefined
    const invalid = () => new LedgerError(500, 'bridge.proxy-response-invalid', `Invalid response from bridge while querying ${what}`)
    const auth = req.headers.authorization
    let body: any
    try {
      // The bridge's `secure` rules apply as on any call to it (routes2), beside the client's token.
      const secured = await core.secureHeaders(scope, bridge)
      const res = await fetch(`${bridge.data.config?.server}/wallets/${address}/${what}${lookup ? '/!lookup' : ''}`, {
        method: lookup ? 'POST' : 'GET',
        headers: { ...(auth ? { authorization: auth } : {}), ...secured, 'x-ledger': scope, ...(lookup ? { 'content-type': 'application/json' } : {}) },
        body: lookup ? JSON.stringify(lookup) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      body = res.ok ? await res.json() : undefined
    } catch {
      throw invalid()
    }
    // The reference refused full records here (`hash`, `meta`): the data is checked like a create's.
    const valid = (d: any) => {
      if (what === 'domains') return d && typeof d === 'object' && typeof d.handle === 'string'
      try {
        validateBody('anchors', { data: d })
        return true
      } catch {
        return false
      }
    }
    if (!Array.isArray(body?.data) || !body.data.every(valid)) throw invalid()
    return body.data.map((d: any) => ({ data: { access: [], ...d }, meta: {} }))
  }

  const localAnchors = async (scope: string, address: string) =>
    [...(await store.list(scope, 'anchors')).filter((a) => a.data.wallet === address)].reverse()

  app.get<{ Params: { id: string } }>('/api/v2/wallets/:id/anchors', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    await acl.authorize('read', 'anchor', { who }, { ledger })
    const scope = ledger.data.handle
    return envelope(req.ledgerKey, (await fromBridge(req, scope, req.params.id, 'anchors')) ?? (await localAnchors(scope, req.params.id)))
  })

  // The body names the wallet it looks up in; it must be the one in the path.
  app.post<{ Params: { id: string } }>('/api/v2/wallets/:id/anchors/!lookup', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    const body = req.body as any
    verifyProofs(body)
    await acl.authorize('lookup', 'anchor', { who, proofs: proofKeys(body) }, { ledger })
    if (body?.data?.wallet !== req.params.id) throw new LedgerError(422, 'record.invalid', 'Address in the request does not match the address in the data')
    const scope = ledger.data.handle
    // The bridge gets the data signed by the ledger, not the client's proofs (recorded).
    const forwarded = { hash: body.hash, data: body.data, meta: { proofs: [serverProof(body.hash, { moment: now() }, req.ledgerKey!, 'system')] } }
    const bridged = await fromBridge(req, scope, req.params.id, 'anchors', forwarded)
    if (bridged) return envelope(req.ledgerKey, bridged)
    // Recorded (routes2): without a bridge to ask, nothing is found, whatever anchors the wallet has.
    return envelope(req.ledgerKey, [])
  })

  app.get<{ Params: { id: string } }>('/api/v2/wallets/:id/domains', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    await acl.authorize('read', 'wallet', { who }, { ledger })
    return envelope(req.ledgerKey, (await fromBridge(req, ledger.data.handle, req.params.id, 'domains')) ?? [])
  })

  app.get<{ Params: { id: string } }>('/api/v2/wallets/:id/balances', async (req) => {
    const who = await authenticate(req)
    const { ledger, found } = await existing(req, 'wallets', req.params.id)
    await acl.authorize('read', 'wallet', { who }, { ledger, record: found })
    // Ordered by symbol, then schema — not by creation (a eur row created after the
    // usd rows is listed first on the reference).
    const rows = (await store.balances(ledger.data.handle, found.data.handle)).sort(
      (a, b) => a.data.symbol.localeCompare(b.data.symbol) || a.data.schema.localeCompare(b.data.schema),
    )
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice(rows, p), { page: { ...p, total: rows.length } })
  })

  app.get<{ Params: { id: string } }>('/api/v2/wallets/:id/limits', async (req) => {
    const who = await authenticate(req)
    const { ledger, found } = await existing(req, 'wallets', req.params.id)
    await acl.authorize('read', 'wallet', { who }, { ledger, record: found })
    const rows = await store.limits(ledger.data.handle, found.data.handle)
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice(rows, p), { page: { ...p, total: rows.length } })
  })

  // ---- circle signers -------------------------------------------------------------

  // Membership links `{circle, signer}` live under their circle. Creating one answers
  // 200, not 201 (observed), and needs `assign-signer` on the circle.
  app.post<{ Params: { id: string } }>('/api/v2/circles/:id/signers', async (req, reply) => {
    validateBody('circle-signers', req.body)
    const who = await authenticate(req)
    const { ledger, found } = await existing(req, 'circles', req.params.id)
    await acl.authorize('assign-signer', 'circle', { who, proofs: proofKeys(req.body) }, { ledger, record: found })
    const data = (req.body as any).data
    if (data.circle !== found.data.handle) throw errors.notFound('Circle')
    if (!(await store.get(ledger.data.handle, 'signers', data.signer))) throw errors.notFound('Signer')
    reply.status(200).send(await create('circle-signers', ledger.data.handle, req.ledgerKey!, req))
  })

  const circleLinks = async (ledger: string, circle: string) =>
    (await store.list(ledger, 'circle-signers')).filter((l) => l.data.circle === circle)

  app.get<{ Params: { id: string } }>('/api/v2/circles/:id/signers', async (req) => {
    const who = await authenticate(req)
    const { ledger, found } = await existing(req, 'circles', req.params.id)
    await acl.authorize('read', 'circle', { who }, { ledger, record: found })
    return listPage(req, await circleLinks(ledger.data.handle, found.data.handle))
  })

  app.get<{ Params: { id: string; link: string } }>('/api/v2/circles/:id/signers/:link', async (req) => {
    const who = await authenticate(req)
    const { ledger, found } = await existing(req, 'circles', req.params.id)
    await acl.authorize('read', 'circle', { who }, { ledger, record: found })
    const link = (await circleLinks(ledger.data.handle, found.data.handle)).find((l) => l.luid === req.params.link || l.data.signer === req.params.link)
    if (!link) throw errors.notFound('Circle signer')
    return link
  })

  const dropLink = async (req: FastifyRequest<{ Params: { id: string; link: string } }>, reply: FastifyReply) => {
    const who = await authenticate(req)
    const { ledger, found } = await existing(req, 'circles', req.params.id)
    await acl.authorize('remove-signer', 'circle', { who, proofs: proofKeys(req.body) }, { ledger, record: found })
    const link = (await circleLinks(ledger.data.handle, found.data.handle)).find((l) => l.luid === req.params.link || l.data.signer === req.params.link)
    if (!link) throw errors.notFound('Circle signer')
    verifyProofs(req.body)
    await store.remove(ledger.data.handle, 'circle-signers', keyOf(link))
    reply.status(204).send()
  }
  app.delete<{ Params: { id: string; link: string } }>('/api/v2/circles/:id/signers/:link', dropLink)
  app.post<{ Params: { id: string; link: string } }>('/api/v2/circles/:id/signers/:link/drop', dropLink)

  return app
}
