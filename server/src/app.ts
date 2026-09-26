// HTTP surface of the ledger. Routes, envelopes and error codes follow the Minka
// Ledger API as the official SDK and CLI use it; everything behind them is ours.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { jwtVerify } from 'jose'
import { customAlphabet } from 'nanoid'
import { AccessControl, type Access, type Principal } from './access.js'
import { Core } from './core.js'
import { digestFor, generateKeyPair, hashData, publicKeyObject, serverProof, verifyDigest, type KeyPair, type Proof } from './crypto.js'
import { LedgerError, errors } from './errors.js'
import { newLuid, newThread } from './ids.js'
import { validateBody, type ValidatedKind } from './schemas.js'
import { keyOf, type Store, type StoredRecord } from './store.js'
import { applyStatus } from './status.js'

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
}

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
} as const
type Kind = keyof typeof KINDS

/** Kinds with the full record surface under `/api/v2/<kind>`. */
const TOP_LEVEL = ['symbols', 'wallets', 'intents', 'signers', 'circles', 'policies'] as const
/** Kinds a client may update and sign after creation. Intents are immutable. */
const MUTABLE = ['symbols', 'wallets', 'signers', 'circles', 'policies'] as const

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

export function buildApp({ store, core = new Core(store), onRoute, serverRules = DEFAULT_SERVER_RULES }: AppOptions) {
  const app = Fastify({ logger: false })
  if (onRoute) app.addHook('onRoute', (r) => [r.method].flat().forEach((m) => onRoute(m, r.url)))
  const acl = new AccessControl(store, serverRules)
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

  // Bearer tokens are EdDSA JWTs signed by the caller; `kid` carries the raw public
  // key. A request without a token is anonymous — access rules decide what it may do.
  // A token that is present but does not verify is rejected outright.
  //
  // The `hsh` claim binds a token to one request (method, absolute URL, body), which a
  // server behind a reverse proxy can only check against the URL the client used.
  // Not verified yet: see README, "Known gaps".
  async function authenticate(req: FastifyRequest): Promise<Principal | undefined> {
    const header = req.headers.authorization
    if (!header) return undefined
    if (!header.startsWith('Bearer ')) throw errors.unauthorized()
    const token = header.slice(7)
    try {
      const [h] = token.split('.')
      const { kid } = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
      if (typeof kid !== 'string') throw new Error('kid')
      const { payload } = await jwtVerify(token, publicKeyObject(kid), { algorithms: ['EdDSA'] })
      return { public: kid, claims: payload }
    } catch {
      throw errors.unauthorized()
    }
  }

  const proofKeys = (body: any): string[] => (body?.meta?.proofs ?? []).map((p: any) => p.public)

  // ---- token impersonation -------------------------------------------------------

  // When the token's key belongs to a signer record of the ledger, the ledger's
  // `system.auth` signer signs the request on that signer's behalf
  // (about-authentication, "token impersonation"). The proof carries the token's
  // claims as `bearer.*`, `origin: self-signed-token`, and the signer and issuer
  // handles. Observed (access3): it is added even when the client signed the body
  // itself, and its key becomes an owner. A token whose key is not a signer record
  // impersonates nothing (access, l0).
  //
  // Partial proofs — without `public` — are templates: each becomes an impersonated
  // proof carrying its `custom`. A body with no proofs and no hash is hashed here.
  // Returns the keys access rules see: the token's key stands for the proofs made
  // on its behalf.
  async function impersonate(body: any, ledger: string, who: Principal | undefined, status?: string): Promise<string[]> {
    const signer = who && (await signerByKey(ledger, who.public))
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
      origin: 'self-signed-token',
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
      if (auth && p.public === auth && p.origin === 'self-signed-token') return p
      const { origin: _o, signer: _s, issuer: _i, ...plain } = p
      const signer = signers.find((s) => s.data.public === p.public)?.data.handle
      return { ...plain, ...(origin ? { origin: 'key-pair' } : {}), ...(signer ? { signer } : {}) }
    })
  }

  // ---- record creation -----------------------------------------------------------

  // A change is the full record as it was after one create/update, numbered from 1.
  const snapshot = (r: StoredRecord, change: number, action: 'create' | 'update', moment = r.meta.moment): StoredRecord => ({
    ...r,
    meta: { ...r.meta, moment, change, action, labels: null },
  })

  async function addChange(scope: string, kind: Kind, r: StoredRecord, action: 'create' | 'update', moment?: string) {
    const n = (await store.changes(scope, kind, keyOf(r))).length + 1
    await store.addChange(scope, kind, keyOf(r), snapshot(r, n, action, moment))
  }

  // Stores a new record and returns it; the caller answers only after everything the
  // record depends on is written, so a client's next request never outruns it.
  async function create(kind: Kind, scope: string, key: KeyPair, req: FastifyRequest) {
    const body = req.body as any
    const proofs = verifyProofs(body)
    const luid = newLuid(KINDS[kind].luid)
    const moment = now()
    const sign = (custom: Record<string, unknown>) => serverProof(body.hash, custom, key, 'system')
    const owners = [...new Set(proofs.map((p) => p.public))]
    // Circle-signer links come back with the client proof untouched (no origin) and
    // without a status, unlike every other record.
    const link = kind === 'circle-signers'
    const clientProofs = await annotate(scope, proofs, !link)

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
          domains: [],
          moment,
          owners,
        },
      }
    else
      record = {
        hash: body.hash,
        // The reference ledger materialises an absent ledger `config` as null after
        // the client hashed the data, so the stored data no longer hashes to `hash`.
        // Clients may depend on the field, so the quirk is reproduced.
        data: kind === 'ledgers' ? { ...body.data, config: body.data.config ?? null } : body.data,
        luid,
        meta: {
          proofs: [...clientProofs, sign({ luid, moment: now(), status: 'created' })],
          ...(link ? {} : { status: 'created' }),
          moment,
          owners,
        },
      }
    if (!(await store.insert(scope, kind, record))) throw errors.duplicated(KINDS[kind].name, body.data.handle)
    await addChange(scope, kind, record, 'create')
    if (kind === 'intents') core.schedule(scope, body.data.handle)
    return record
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

  // Record lists come newest first and carry no total.
  function listPage(req: FastifyRequest, rows: StoredRecord[]) {
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice([...rows].reverse(), p), { page: p })
  }

  // Changes list newest first, with a total.
  async function changePage(req: FastifyRequest, scope: string, kind: Kind, key: string) {
    const all = (await store.changes(scope, kind, key)).reverse()
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice(all, p), { page: { ...p, total: all.length } })
  }

  // ---- ledgers -------------------------------------------------------------------

  // Any authenticated signer may create a ledger (server rule). The ledger gets four
  // signers of its own: `system` signs what the ledger says, `core` signs its part as
  // a participant in moving balances; `system.auth` and `system.dtc` are published
  // like on the reference and reserved for token impersonation and data transfer.
  app.post('/api/v2/ledgers', async (req, reply) => {
    validateBody('ledgers', req.body)
    const who = await authenticate(req)
    if (!who) throw errors.forbidden('create', 'ledger')
    await acl.authorizeServer('create', 'ledger', { who, proofs: proofKeys(req.body) })
    const handle = (req.body as any).data.handle
    const keys = { system: generateKeyPair(), core: generateKeyPair(), 'system.auth': generateKeyPair(), 'system.dtc': generateKeyPair() }
    const record = await create('ledgers', '', keys.system, req)
    // Published newest first on the reference: system, core, system.auth, system.dtc.
    for (const name of ['system.dtc', 'system.auth', 'core', 'system'] as const) {
      await store.putKey(handle, keys[name], name)
      await publishSigner(handle, name, keys[name], keys.system)
    }
    reply.status(201).send(record)
  })

  app.get('/api/v2/ledger', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    await acl.authorize('read', 'ledger', { who }, { ledger, record: ledger })
    return ledger
  })

  app.get('/api/v2/ledger/changes', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    await acl.authorize('read', 'ledger', { who }, { ledger, record: ledger })
    return changePage(req, '', 'ledgers', ledger.data.handle)
  })

  // ---- records -------------------------------------------------------------------

  for (const kind of TOP_LEVEL) {
    const record = KINDS[kind].record

    app.post(`/api/v2/${kind}`, async (req, reply) => {
      validateBody(kind as ValidatedKind, req.body)
      const who = await authenticate(req)
      const ledger = await hostedLedger(req)
      const keys = await impersonate(req.body, ledger.data.handle, who, 'created')
      await acl.authorize('create', record, { who, proofs: keys }, { ledger })
      reply.status(201).send(await create(kind, ledger.data.handle, req.ledgerKey!, req))
    })

    app.get(`/api/v2/${kind}`, async (req) => {
      const who = await authenticate(req)
      const ledger = await hostedLedger(req)
      await acl.authorize('read', record, { who }, { ledger })
      return listPage(req, await store.list(ledger.data.handle, kind))
    })

    app.get<{ Params: { id: string } }>(`/api/v2/${kind}/:id`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      await acl.authorize('read', record, { who }, { ledger, record: found })
      return found
    })

    app.get<{ Params: { id: string } }>(`/api/v2/${kind}/:id/changes`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      await acl.authorize('read', record, { who }, { ledger, record: found })
      return changePage(req, ledger.data.handle, kind, keyOf(found))
    })

    app.get<{ Params: { id: string; change: string } }>(`/api/v2/${kind}/:id/changes/:change`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      await acl.authorize('read', record, { who }, { ledger, record: found })
      const all = await store.changes(ledger.data.handle, kind, keyOf(found))
      const change = all.find((c) => String(c.meta.change) === req.params.change)
      if (!change) throw errors.changeNotFound()
      return change
    })

    // Access check: which rules grant the requested action on this record to the
    // caller. Answered as a list of signed rules, without a page.
    app.post<{ Params: { id: string } }>(`/api/v2/${kind}/:id/access/!check`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      await acl.authorize('read', record, { who }, { ledger, record: found })
      const body = req.body as any
      const action = body?.data?.action ?? 'read'
      const access: Access = { who, proofs: action === 'read' ? [] : proofKeys(body) }
      const matching = await acl.matching(action, record, access, { ledger, record: found })
      return envelope(req.ledgerKey, matching.map((rule) => envelope(req.ledgerKey, rule)))
    })
  }

  for (const kind of MUTABLE) {
    const record = KINDS[kind].record

    // Update: a new version whose data names the current hash as `parent`. The
    // record keeps its luid, status and owners; the ledger countersigns with luid only.
    app.put<{ Params: { id: string } }>(`/api/v2/${kind}/:id`, async (req) => {
      validateBody(kind as ValidatedKind, req.body)
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      const body = req.body as any
      const keys = await impersonate(req.body, ledger.data.handle, who)
      await acl.authorize('update', record, { who, proofs: keys }, { ledger, record: found })
      if (body.data.parent !== found.hash) throw errors.parentHashInvalid()
      const proofs = await annotate(ledger.data.handle, verifyProofs(body))
      const updated: StoredRecord = {
        hash: body.hash,
        data: body.data,
        luid: found.luid,
        meta: { ...found.meta, proofs: [...proofs, serverProof(body.hash, { luid: found.luid, moment: now() }, req.ledgerKey!, 'system')], moment: now() },
      }
      await store.update(ledger.data.handle, kind, updated)
      await addChange(ledger.data.handle, kind, updated, 'update')
      return updated
    })

    // A proof on the current version. With `custom.status` it asks for a status
    // change, which status policies may refuse or leave waiting for a quorum. The
    // ledger appends the proof as sent and does not countersign.
    app.post<{ Params: { id: string } }>(`/api/v2/${kind}/:id/proofs`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      // A proof without `public` is a template the token's signer is impersonated on.
      const sent = req.body as any
      const wrapped = { hash: found.hash, data: found.data, meta: { proofs: sent && !sent.public ? [sent] : [] } }
      const keys = wrapped.meta.proofs.length ? await impersonate(wrapped, ledger.data.handle, who) : sent?.public ? [sent.public] : []
      const proof: any = wrapped.meta.proofs.at(-1) ?? sent
      await acl.authorize('update', record, { who, proofs: keys.filter(Boolean) }, { ledger, record: found })
      if (!proof?.digest || !proof?.public || !proof?.result) throw errors.signatureMissing()
      if (proof.digest !== digestFor(found.hash, proof.custom) || !verifyDigest(proof.digest, proof.public, proof.result))
        throw errors.signatureInvalid(proof.public)
      const [stored] = await annotate(ledger.data.handle, [proof])
      await applyStatus(store, acl, ledger, record, found, stored)
      await store.update(ledger.data.handle, kind, found)
      await addChange(ledger.data.handle, kind, found, 'update', now())
      return found
    })
  }

  // ---- wallets -------------------------------------------------------------------

  // Drop: signed like an update (data.parent = current hash). A wallet that still
  // holds a balance cannot be dropped.
  const dropWallet = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    validateBody('drop', req.body)
    const who = await authenticate(req)
    const { ledger, found } = await existing(req, 'wallets', req.params.id)
    const body = req.body as any
    const keys = await impersonate(req.body, ledger.data.handle, who, 'dropped')
    await acl.authorize('drop', 'wallet', { who, proofs: keys }, { ledger, record: found })
    if (body.data.parent !== found.hash) throw errors.parentHashInvalid()
    verifyProofs(body)
    const held = (await store.balances(ledger.data.handle, found.data.handle)).filter((b) => b.data.amount !== 0)
    if (held.length) throw errors.dropRejected(`Wallet ${found.data.handle} still holds a balance.`)
    await store.remove(ledger.data.handle, 'wallets', found.data.handle)
    reply.status(204).send()
  }
  app.delete<{ Params: { id: string } }>('/api/v2/wallets/:id', dropWallet)
  app.post<{ Params: { id: string } }>('/api/v2/wallets/:id/drop', dropWallet)

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
