// HTTP surface of the ledger. Routes, envelopes and error codes follow the Minka
// Ledger API as the official SDK and CLI use it; everything behind them is ours.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { jwtVerify } from 'jose'
import { Core } from './core.js'
import { digestFor, generateKeyPair, hashData, publicKeyObject, serverProof, verifyDigest, type KeyPair, type Proof } from './crypto.js'
import { LedgerError, errors } from './errors.js'
import { newLuid, newThread } from './ids.js'
import { validateBody } from './schemas.js'
import type { Store, StoredRecord } from './store.js'

export type AppOptions = { store: Store; core?: Core }

// Record kinds: path segment → luid prefix, name used in error details, and the
// record type that access rules refer to.
const KINDS = {
  ledgers: { luid: '$ldg', name: 'Ledger', record: 'ledger' },
  symbols: { luid: '$sym', name: 'Symbol', record: 'symbol' },
  wallets: { luid: '$wlt', name: 'Wallet', record: 'wallet' },
  intents: { luid: '$int', name: 'Intent', record: 'intent' },
} as const
type Kind = keyof typeof KINDS

const PAGE_LIMIT = 20

declare module 'fastify' {
  interface FastifyRequest {
    /** Signer of the ledger this request addresses, once it has been resolved. */
    ledgerKey?: KeyPair
  }
}

export function buildApp({ store, core = new Core(store) }: AppOptions) {
  const app = Fastify({ logger: false })
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

  // Ledger-level access rules. A rule grants an action on a record type to the
  // principal it names; a rule that names no signer and no bearer grants it to
  // everyone, which is why `{action: any, record: any}` lets anonymous reads through
  // on the reference ledger. Record-level rules arrive with L4.
  function authorize(rules: any[] | undefined, action: string, record: string, who?: Principal) {
    const granted = (rules ?? []).some((r) => {
      if (r.action !== 'any' && r.action !== action) return false
      if (r.record && r.record !== 'any' && r.record !== record) return false
      if (r.signer) return !!who && r.signer.public === who.public
      if (r.bearer) return !!who && (r.bearer.$signer?.public === undefined || r.bearer.$signer.public === who.public)
      return true
    })
    if (!granted) throw errors.forbidden()
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

  async function create(kind: Kind, scope: string, key: KeyPair, req: FastifyRequest, reply: FastifyReply) {
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
    if (kind === 'intents') core.schedule(scope, body.data.handle)
    reply.status(201).send(record)
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

  // ---- routes --------------------------------------------------------------------

  // Any authenticated signer may create a ledger, as on the public reference server.
  // The ledger gets two signers of its own: `system` signs what the ledger says,
  // `core` signs its part as a participant in moving balances.
  app.post('/api/v2/ledgers', async (req, reply) => {
    validateBody('ledgers', req.body)
    if (!(await authenticate(req))) throw errors.forbidden()
    const handle = (req.body as any).data.handle
    const system = generateKeyPair()
    await create('ledgers', '', system, req, reply)
    await store.putKey(handle, system, 'system')
    await store.putKey(handle, generateKeyPair(), 'core')
  })

  app.get('/api/v2/ledger', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    authorize(ledger.data.access, 'read', 'ledger', who)
    return ledger
  })

  for (const kind of ['symbols', 'wallets', 'intents'] as const) {
    const record = KINDS[kind].record

    app.post(`/api/v2/${kind}`, async (req, reply) => {
      validateBody(kind, req.body)
      const who = await authenticate(req)
      const ledger = await hostedLedger(req)
      authorize(ledger.data.access, 'create', record, who)
      await create(kind, ledger.data.handle, req.ledgerKey!, req, reply)
    })

    app.get(`/api/v2/${kind}`, async (req) => {
      const who = await authenticate(req)
      const ledger = await hostedLedger(req)
      authorize(ledger.data.access, 'read', record, who)
      return page(req, ledger.data.handle, kind)
    })

    app.get<{ Params: { handle: string } }>(`/api/v2/${kind}/:handle`, async (req) => {
      const who = await authenticate(req)
      const ledger = await hostedLedger(req)
      authorize(ledger.data.access, 'read', record, who)
      const found = await find(ledger.data.handle, kind, req.params.handle)
      if (!found) throw errors.notFound(KINDS[kind].name)
      return found
    })
  }

  app.get<{ Params: { handle: string } }>('/api/v2/wallets/:handle/balances', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    authorize(ledger.data.access, 'read', 'wallet', who)
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
    authorize(ledger.data.access, 'read', 'wallet', who)
    if (!(await store.get(ledger.data.handle, 'wallets', req.params.handle))) throw errors.notFound('Wallet')
    const rows = await store.limits(ledger.data.handle, req.params.handle)
    const p = pageParams(req)
    return envelope(req.ledgerKey, slice(rows, p), { page: { ...p, total: rows.length } })
  })

  return app
}
