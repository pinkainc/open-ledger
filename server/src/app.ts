// HTTP surface of the ledger. Routes, envelopes and error codes follow the Minka
// Ledger API as the official SDK and CLI use it; everything behind them is ours.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { jwtVerify } from 'jose'
import { Core } from './core.js'
import { digestFor, generateKeyPair, hashData, publicKeyObject, serverProof, verifyDigest, type KeyPair, type Proof } from './crypto.js'
import { LedgerError, errors } from './errors.js'
import { newLuid, newThread } from './ids.js'
import { customAlphabet } from 'nanoid'
import { validateBody } from './schemas.js'
import type { Store, StoredRecord } from './store.js'

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
// record type that access rules refer to.
const KINDS = {
  ledgers: { luid: '$ldg', name: 'Ledger', record: 'ledger' },
  symbols: { luid: '$sym', name: 'Symbol', record: 'symbol' },
  wallets: { luid: '$wlt', name: 'Wallet', record: 'wallet' },
  intents: { luid: '$int', name: 'Intent', record: 'intent' },
  signers: { luid: '$snr', name: 'Signer', record: 'signer' },
} as const
type Kind = keyof typeof KINDS

const PAGE_LIMIT = 20

declare module 'fastify' {
  interface FastifyRequest {
    /** Signer of the ledger this request addresses, once it has been resolved. */
    ledgerKey?: KeyPair
  }
}

const DEFAULT_SERVER_RULES = [{ action: 'access' }, { action: 'create', record: 'ledger' }]

export function buildApp({ store, core = new Core(store), onRoute, serverRules = DEFAULT_SERVER_RULES }: AppOptions) {
  const app = Fastify({ logger: false })
  if (onRoute) app.addHook('onRoute', (r) => [r.method].flat().forEach((m) => onRoute(m, r.url)))
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

  // ---- authentication and access ------------------------------------------------

  // Bearer tokens are EdDSA JWTs signed by the caller; `kid` carries the raw public
  // key. A request without a token is anonymous — access rules decide what it may do.
  // A token that is present but does not verify is rejected outright.
  //
  // The `hsh` claim binds a token to one request (method, absolute URL, body), which a
  // server behind a reverse proxy can only check against the URL the client used.
  // Not verified yet: see README, "Known gaps".
  type Principal = { public: string; claims: Record<string, unknown> }

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

  // Access rules (about-authorization): a rule grants an action on a record type.
  //   `signer` — matched against the signers of the request's proofs, so it only ever
  //              grants mutations; a read carries no proofs.
  //   `bearer` — matched against the JWT: its claims, and `$signer` against the key
  //              that signed it.
  //   neither  — grants to everyone, which is why `{action: any, record: any}` lets
  //              anonymous reads through on the reference.
  // Rules are additive across levels: record, then ledger, then server; any single
  // match grants. The reference's access check confirms the signer/read split: an
  // owner's `{any, signer}` rule is not listed as granting `read`.
  type Access = { who?: Principal; proofs?: string[] }

  const oneOf = (v: any, x: string) =>
    v === undefined || v === 'any' || v === x || (Array.isArray(v?.$in) && v.$in.includes(x) && !(v.$nin ?? []).includes(x)) ||
    (Array.isArray(v?.$nin) && !v.$in && !v.$nin.includes(x))

  function keyMatches(matcher: any, key: string) {
    if (!matcher || typeof matcher !== 'object') return false
    if (matcher.$in) return matcher.$in.some((m: any) => keyMatches(m, key))
    if (matcher.public !== undefined) return matcher.public === key
    return Object.keys(matcher).length === 0
  }

  function grants(r: any, action: string, record: string, { who, proofs = [] }: Access) {
    if (r.policy !== undefined) return false // access policies: L4, not yet
    if (!oneOf(r.action, action) && r.action !== 'any') return false
    if (!oneOf(r.record, record)) return false
    if (r.signer) return proofs.some((k) => keyMatches(r.signer, k))
    if (r.bearer) {
      if (!who) return false
      const { $signer, ...claims } = r.bearer
      if ($signer && !keyMatches($signer, who.public)) return false
      return Object.entries(claims).every(([k, v]) => who.claims[k] === v)
    }
    return true
  }

  const rulesOf = (...levels: (any[] | undefined)[]) => levels.flatMap((l) => l ?? [])

  function authorize(rules: any[], action: string, record: string, access: Access) {
    if (!rules.some((r) => grants(r, action, record, access))) throw errors.forbidden()
  }

  async function hostedLedger(req: FastifyRequest) {
    const handle = req.headers['x-ledger']
    if (typeof handle !== 'string' || !handle) throw errors.ledgerNotHosted()
    const ledger = await store.get('', 'ledgers', handle)
    if (!ledger) throw errors.ledgerNotHosted()
    return ledger
  }

  // ---- record creation -----------------------------------------------------------

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

  // Stores a new record and returns it; the caller answers only after everything the
  // record depends on is written, so a client's next request never outruns it.
  async function create(kind: Kind, scope: string, key: KeyPair, req: FastifyRequest) {
    const body = req.body as any
    const proofs = verifyProofs(body)
    const luid = newLuid(KINDS[kind].luid)
    const moment = now()
    const sign = (custom: Record<string, unknown>) => serverProof(body.hash, custom, key, 'system')

    // Client proofs come back tagged with their origin; the ledger appends its own.
    const clientProofs = proofs.map((p) => ({ ...p, origin: p.origin ?? 'key-pair' }))
    const owners = [...new Set(proofs.map((p) => p.public))]
    const record: StoredRecord =
      kind === 'intents'
        ? {
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
        : {
            hash: body.hash,
            // The reference ledger materialises an absent ledger `config` as null after
            // the client hashed the data, so the stored data no longer hashes to `hash`.
            // Clients may depend on the field, so the quirk is reproduced.
            data: kind === 'ledgers' ? { ...body.data, config: body.data.config ?? null } : body.data,
            luid,
            meta: { proofs: [...clientProofs, sign({ luid, moment: now(), status: 'created' })], status: 'created', moment, owners },
          }
    if (!(await store.insert(scope, kind, record))) throw errors.duplicated(KINDS[kind].name, body.data.handle)
    await store.addChange(scope, kind, body.data.handle, snapshot(record, 1, 'create'))
    if (kind === 'intents') core.schedule(scope, body.data.handle)
    return record
  }

  // A change is the full record as it was after one create/update, numbered from 1.
  const snapshot = (r: StoredRecord, change: number, action: 'create' | 'update', moment = r.meta.moment): StoredRecord => ({
    ...r,
    meta: { ...r.meta, moment, change, action, labels: null },
  })

  // The ledger publishes its server signers as signer records, each self-signed and
  // countersigned by `system`. Their secrets live elsewhere; the record only holds a
  // reference in the reference's `{{ secret.<id> }}` form.
  async function publishSigner(ledger: string, handle: string, key: KeyPair, system: KeyPair) {
    const secretId = customAlphabet('abcdefghijklmnopqrstuvwxyz', 16)()
    const data = { handle, access: [{ action: 'read' }], format: key.format, public: key.public, secret: `{{ secret.${secretId} }}` }
    const hash = hashData(data)
    const luid = newLuid('$snr')
    const moment = now()
    const own = serverProof(hash, { moment, status: 'created' }, key, handle)
    const { signer: _s, origin: _o, ...self } = own
    const record: StoredRecord = {
      hash,
      data,
      luid,
      meta: { proofs: [self, serverProof(hash, { luid, moment: now(), status: 'created' }, system, 'system')], status: 'created', moment, owners: [key.public] },
    }
    await store.insert(ledger, 'signers', record)
    await store.addChange(ledger, 'signers', handle, snapshot(record, 1, 'create'))
  }

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
  async function page(req: FastifyRequest, scope: string, kind: Kind) {
    const all = (await store.list(scope, kind)).reverse()
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice(all, p), { page: p })
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

  async function addChange(scope: string, kind: Kind, r: StoredRecord, action: 'update', moment?: string) {
    const n = (await store.changes(scope, kind, r.data.handle)).length + 1
    await store.addChange(scope, kind, r.data.handle, snapshot(r, n, action, moment))
  }

  // Changes list newest first, with a total.
  async function changePage(req: FastifyRequest, scope: string, kind: Kind, handle: string) {
    const all = (await store.changes(scope, kind, handle)).reverse()
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice(all, p), { page: { ...p, total: all.length } })
  }

  // ---- routes --------------------------------------------------------------------

  const proofKeys = (body: any): string[] => (body?.meta?.proofs ?? []).map((p: any) => p.public)

  // Any authenticated signer may create a ledger (server rule). The ledger gets four
  // signers of its own: `system` signs what the ledger says, `core` signs its part as
  // a participant in moving balances; `system.auth` and `system.dtc` are published
  // like on the reference and reserved for token impersonation and data transfer.
  app.post('/api/v2/ledgers', async (req, reply) => {
    validateBody('ledgers', req.body)
    const who = await authenticate(req)
    if (!who) throw errors.forbidden()
    authorize(serverRules, 'create', 'ledger', { who, proofs: proofKeys(req.body) })
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
    authorize(rulesOf(ledger.data.access, serverRules), 'read', 'ledger', { who })
    return ledger
  })

  app.get('/api/v2/ledger/changes', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    authorize(rulesOf(ledger.data.access, serverRules), 'read', 'ledger', { who })
    return changePage(req, '', 'ledgers', ledger.data.handle)
  })

  for (const kind of ['symbols', 'wallets', 'intents', 'signers'] as const) {
    const record = KINDS[kind].record

    app.post(`/api/v2/${kind}`, async (req, reply) => {
      validateBody(kind, req.body)
      const who = await authenticate(req)
      const ledger = await hostedLedger(req)
      authorize(rulesOf(ledger.data.access, serverRules), 'create', record, { who, proofs: proofKeys(req.body) })
      reply.status(201).send(await create(kind, ledger.data.handle, req.ledgerKey!, req))
    })

    app.get(`/api/v2/${kind}`, async (req) => {
      const who = await authenticate(req)
      const ledger = await hostedLedger(req)
      authorize(rulesOf(ledger.data.access, serverRules), 'read', record, { who })
      return page(req, ledger.data.handle, kind)
    })

    app.get<{ Params: { id: string } }>(`/api/v2/${kind}/:id`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      authorize(rulesOf(found.data.access, ledger.data.access, serverRules), 'read', record, { who })
      return found
    })

    app.get<{ Params: { id: string } }>(`/api/v2/${kind}/:id/changes`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      authorize(rulesOf(found.data.access, ledger.data.access, serverRules), 'read', record, { who })
      return changePage(req, ledger.data.handle, kind, found.data.handle)
    })

    app.get<{ Params: { id: string; change: string } }>(`/api/v2/${kind}/:id/changes/:change`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      authorize(rulesOf(found.data.access, ledger.data.access, serverRules), 'read', record, { who })
      const all = await store.changes(ledger.data.handle, kind, found.data.handle)
      const change = all.find((c) => String(c.meta.change) === req.params.change)
      if (!change) throw errors.changeNotFound()
      return change
    })

    // Access check: which rules grant the requested action on this record to the
    // caller. Answered as a list of signed rules, without a page.
    app.post<{ Params: { id: string } }>(`/api/v2/${kind}/:id/access/!check`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      authorize(rulesOf(found.data.access, ledger.data.access, serverRules), 'read', record, { who })
      const body = req.body as any
      const action = body?.data?.action ?? 'read'
      const access = { who, proofs: action === 'read' ? [] : proofKeys(body) }
      const matching = rulesOf(found.data.access, ledger.data.access, serverRules).filter((r) => grants(r, action, record, access))
      return envelope(req.ledgerKey, matching.map((rule) => envelope(req.ledgerKey, rule)))
    })
  }

  // Updates, status proofs and drops for the kinds the reference lets clients change.
  for (const kind of ['symbols', 'wallets', 'signers'] as const) {
    const record = KINDS[kind].record

    // Update: a new version whose data names the current hash as `parent`. The
    // record keeps its luid, status and owners; the ledger countersigns with luid only.
    app.put<{ Params: { id: string } }>(`/api/v2/${kind}/:id`, async (req) => {
      validateBody(kind, req.body)
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      const body = req.body as any
      authorize(rulesOf(found.data.access, ledger.data.access, serverRules), 'update', record, { who, proofs: proofKeys(body) })
      if (body.data.parent !== found.hash) throw errors.parentHashInvalid()
      const proofs = verifyProofs(body)
      const moment = now()
      const updated: StoredRecord = {
        hash: body.hash,
        data: body.data,
        luid: found.luid,
        meta: {
          ...found.meta,
          proofs: [...proofs.map((p) => ({ ...p, origin: p.origin ?? 'key-pair' })), serverProof(body.hash, { luid: found.luid, moment: now() }, req.ledgerKey!, 'system')],
          moment,
        },
      }
      await store.update(ledger.data.handle, kind, updated)
      await addChange(ledger.data.handle, kind, updated, 'update')
      return updated
    })

    // A proof on the current version. With `custom.status` it changes the record's
    // status; the ledger appends it as sent and does not countersign.
    app.post<{ Params: { id: string } }>(`/api/v2/${kind}/:id/proofs`, async (req) => {
      const who = await authenticate(req)
      const { ledger, found } = await existing(req, kind, req.params.id)
      const proof = req.body as any
      authorize(rulesOf(found.data.access, ledger.data.access, serverRules), 'update', record, { who, proofs: proof?.public ? [proof.public] : [] })
      if (!proof?.digest || !proof?.public || !proof?.result) throw errors.signatureMissing()
      if (proof.digest !== digestFor(found.hash, proof.custom) || !verifyDigest(proof.digest, proof.public, proof.result))
        throw errors.signatureInvalid(proof.public)
      found.meta.proofs.push({ ...proof, origin: proof.origin ?? 'key-pair' })
      if (proof.custom && 'status' in proof.custom) {
        if (proof.custom.status === null) delete found.meta.status
        else found.meta.status = proof.custom.status
      }
      await store.update(ledger.data.handle, kind, found)
      await addChange(ledger.data.handle, kind, found, 'update', now())
      return found
    })
  }

  // Drop: signed like an update (data.parent = current hash). A wallet that still
  // holds a balance cannot be dropped.
  const drop = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    validateBody('drop', req.body)
    const who = await authenticate(req)
    const { ledger, found } = await existing(req, 'wallets', req.params.id)
    const body = req.body as any
    authorize(rulesOf(found.data.access, ledger.data.access, serverRules), 'drop', 'wallet', { who, proofs: proofKeys(body) })
    if (body.data.parent !== found.hash) throw errors.parentHashInvalid()
    verifyProofs(body)
    const held = (await store.balances(ledger.data.handle, found.data.handle)).filter((b) => b.data.amount !== 0)
    if (held.length) throw errors.dropRejected(`Wallet ${found.data.handle} still holds a balance.`)
    await store.remove(ledger.data.handle, 'wallets', found.data.handle)
    reply.status(204).send()
  }
  app.delete<{ Params: { id: string } }>('/api/v2/wallets/:id', drop)
  app.post<{ Params: { id: string } }>('/api/v2/wallets/:id/drop', drop)

  app.get<{ Params: { handle: string } }>('/api/v2/wallets/:handle/balances', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    authorize(rulesOf(ledger.data.access, serverRules), 'read', 'wallet', { who })
    if (!(await store.get(ledger.data.handle, 'wallets', req.params.handle))) throw errors.notFound('Wallet')
    // Ordered by symbol, then schema — not by creation (a eur row created after the
    // usd rows is listed first on the reference).
    const rows = (await store.balances(ledger.data.handle, req.params.handle)).sort(
      (a, b) => a.data.symbol.localeCompare(b.data.symbol) || a.data.schema.localeCompare(b.data.schema),
    )
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice(rows, p), { page: { ...p, total: rows.length } })
  })

  app.get<{ Params: { handle: string } }>('/api/v2/wallets/:handle/limits', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    authorize(rulesOf(ledger.data.access, serverRules), 'read', 'wallet', { who })
    if (!(await store.get(ledger.data.handle, 'wallets', req.params.handle))) throw errors.notFound('Wallet')
    const rows = await store.limits(ledger.data.handle, req.params.handle)
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice(rows, p), { page: { ...p, total: rows.length } })
  })

  return app
}
