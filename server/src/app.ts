// HTTP surface of the ledger. Routes, envelopes and error codes follow the Minka
// Ledger API as the official SDK and CLI use it; everything behind them is ours.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { jwtVerify } from 'jose'
import { customAlphabet } from 'nanoid'
import { digestFor, generateKeyPair, hashData, publicKeyObject, serverProof, verifyDigest, type KeyPair, type Proof } from './crypto.js'
import { LedgerError, errors } from './errors.js'
import type { Store, StoredRecord } from './store.js'

export type AppOptions = { store: Store }

// Record kinds of L0: path segment, luid prefix, name used in error details, and the
// data properties the reference ledger requires beyond `handle`.
const KINDS = {
  ledgers: { luid: '$ldg', name: 'Ledger', record: 'ledger', required: ['handle', 'signer'] },
  symbols: { luid: '$sym', name: 'Symbol', record: 'symbol', required: ['handle', 'factor'] },
  wallets: { luid: '$wlt', name: 'Wallet', record: 'wallet', required: ['handle'] },
} as const
type Kind = keyof typeof KINDS

// Same alphabet and length as reference luids ("$wlt.-2vcyddudkeQg6cbj"). They are
// opaque to clients; only the prefix and shape are part of the contract.
const luidBody = customAlphabet('-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz', 16)
const newLuid = (prefix: string) => `${prefix}.-${luidBody()}`

const PAGE_LIMIT = 20

declare module 'fastify' {
  interface FastifyRequest {
    /** Signer of the ledger this request addresses, once it has been resolved. */
    ledgerKey?: KeyPair
  }
}

export function buildApp({ store }: AppOptions) {
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

  app.setErrorHandler((err: any, req, reply) => {
    const e =
      err instanceof LedgerError
        ? err
        : err?.statusCode === 400 && err?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
          ? errors.missingProperty('', 'data')
          : new LedgerError(500, 'api.internal-error', 'Internal error.')
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

  // ---- authentication ----------------------------------------------------------

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

  function validateBody(kind: Kind, body: any) {
    if (!body || typeof body !== 'object') throw errors.missingProperty('', 'data')
    if (!body.data || typeof body.data !== 'object') throw errors.missingProperty('', 'data')
    for (const prop of KINDS[kind].required) if (!(prop in body.data)) throw errors.missingProperty('/data', prop)
  }

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

    // Client proofs come back tagged with their origin; the ledger appends its own
    // proof binding the luid it assigned.
    const clientProofs = proofs.map((p) => ({ ...p, origin: p.origin ?? 'key-pair' }))
    const record: StoredRecord = {
      hash: body.hash,
      // The reference ledger materialises an absent ledger `config` as null after the
      // client hashed the data, so the stored data no longer hashes to `hash`. Clients
      // may depend on the field being present, so the quirk is reproduced.
      data: kind === 'ledgers' ? { ...body.data, config: body.data.config ?? null } : body.data,
      luid,
      meta: {
        proofs: [...clientProofs, serverProof(body.hash, { luid, moment: now(), status: 'created' }, key, 'system')],
        status: 'created',
        moment,
        owners: [...new Set(proofs.map((p) => p.public))],
      },
    }
    if (!(await store.insert(scope, kind, record))) throw errors.duplicated(KINDS[kind].name, body.data.handle)
    reply.status(201).send(record)
  }

  async function page(req: FastifyRequest, scope: string, kind: Kind) {
    const all = await store.list(scope, kind)
    // Record lists carry no total on the reference ledger; balance lists do.
    return envelope(req.ledgerKey, all.slice(0, PAGE_LIMIT), { page: { index: 0, limit: PAGE_LIMIT } })
  }

  // ---- routes --------------------------------------------------------------------

  // Any authenticated signer may create a ledger, as on the public reference server.
  app.post('/api/v2/ledgers', async (req, reply) => {
    validateBody('ledgers', req.body)
    if (!(await authenticate(req))) throw errors.forbidden()
    const handle = (req.body as any).data.handle
    const key = generateKeyPair()
    await create('ledgers', '', key, req, reply)
    await store.putKey(handle, key)
  })

  app.get('/api/v2/ledger', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    authorize(ledger.data.access, 'read', 'ledger', who)
    return ledger
  })

  for (const kind of ['symbols', 'wallets'] as const) {
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
      const found = await store.get(ledger.data.handle, kind, req.params.handle)
      if (!found) throw errors.notFound(KINDS[kind].name)
      return found
    })
  }

  app.get<{ Params: { handle: string } }>('/api/v2/wallets/:handle/balances', async (req) => {
    const who = await authenticate(req)
    const ledger = await hostedLedger(req)
    authorize(ledger.data.access, 'read', 'wallet', who)
    if (!(await store.get(ledger.data.handle, 'wallets', req.params.handle))) throw errors.notFound('Wallet')
    // No money moves before L1, so every wallet is empty.
    return envelope(req.ledgerKey, [], { page: { index: 0, limit: PAGE_LIMIT, total: 0 } })
  })

  return app
}
