// Anchor forwarding by processing policies (moving-money/anchor-forwarding,
// connecting-systems/processing-policies; recorded, forwarding).
//
// A `processing` policy for record `anchor` names, per action, a bridge and a strategy:
//
//   proxy        the bridge answers instead of the ledger; nothing is kept
//   validate     writes: the bridge must accept first, then the ledger writes as usual
//   fallback     reads: the ledger's own record when it has one, else the bridge's
//   synchronize  writes: the ledger keeps what the bridge answered
//
// A policy is in force whatever its status. Without a strategy, reads fall back and
// writes validate (the docs; not recorded). `synchronize` is accepted for drop and
// query, where it means validate and fallback.
//
// Calls go to `{config.server}/v2/anchors[/{id}[/proofs]]` with the ledger's own JWT
// (`iss: ledger:<ledger>`, `sub: system@<ledger>`, `aud: <bridge>`, a day long); the
// client's token travels in `x-forwarded-authorization`. An answer is a signed record
// (or list) whose hash and proofs the ledger checks; an error answer the bridge signed
// reaches the client with its status, reason, detail and custom, the bridge's proofs
// and the ledger's, which names the cause.
import { SignJWT } from 'jose'
import { canonical, hashData, privateKeyObject, verifyDigest, digestFor, type KeyPair, type Proof } from './crypto.js'
import { LedgerError } from './errors.js'
import type { Store, StoredRecord } from './store.js'

export type Strategy = 'proxy' | 'fallback' | 'validate' | 'synchronize'
export type Action = 'read' | 'query' | 'create' | 'update' | 'drop' | 'sign'
export type Aspect = { bridge: StoredRecord; strategy: Strategy }

const READS = new Set<Action>(['read', 'query'])

/** An error the bridge signed, passed on with the bridge's proofs before the ledger's. */
export class ForwardedError extends LedgerError {
  constructor(
    status: number,
    reason: string,
    detail: string,
    custom: Record<string, unknown> | undefined,
    readonly proofs: Proof[],
  ) {
    super(status, reason, detail, custom)
  }
}

export const CAUSED_BY = { detail: 'Error derived from anchor forwarding response' }

const unexpected = (detail = 'Unexpected error while forwarding request to bridge') => new LedgerError(500, 'forward.unexpected-error', detail)

/**
 * The aspect an action on anchors is forwarded by, if any. Several values for one
 * action — in one policy or across policies — fail at use, as does a bridge that
 * does not exist (recorded; both 500).
 */
export async function aspectFor(store: Store, scope: string, action: Action): Promise<Aspect | undefined> {
  const values = (await store.list(scope, 'policies'))
    .filter((p) => p.data.schema === 'processing' && p.data.record === 'anchor')
    .flatMap((p) => (Array.isArray(p.data.values) ? p.data.values : []))
    .filter((v: any) => v?.schema === 'aspect' && v.action === action)
  if (!values.length) return undefined
  if (values.length > 1) throw unexpected(`Multiple processing aspect values found for action ${action}.`)
  const [v] = values
  const bridge = await store.get(scope, 'bridges', v.invoke?.bridge)
  if (!bridge) throw unexpected(`Forward bridge '${v.invoke?.bridge}' configured but not exists`)
  const strategy: Strategy = v.config?.strategy ?? (READS.has(action) ? 'fallback' : 'validate')
  if (strategy === 'synchronize' && action === 'drop') return { bridge, strategy: 'validate' }
  if (strategy === 'synchronize' && action === 'query') return { bridge, strategy: 'fallback' }
  return { bridge, strategy }
}

/** The ledger's token for a call to one of its bridges. */
export function ledgerToken(ledger: string, bridge: string, key: KeyPair) {
  return new SignJWT({ iss: `ledger:${ledger}`, sub: `system@${ledger}`, aud: bridge })
    .setProtectedHeader({ alg: 'EdDSA', kid: key.public })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(privateKeyObject(key))
}

export type Call = {
  ledger: string
  key: KeyPair
  bridge: StoredRecord
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Under `/v2/anchors`, e.g. '' or '/dir-1/proofs'. */
  path: string
  body?: unknown
  /** The client's `authorization` header. */
  client?: string
}

/** Makes one call and returns the bridge's answer, checked: a record, or a list of them. */
export async function forward(c: Call, list = false): Promise<any> {
  let status: number
  let text: string
  try {
    const res = await fetch(`${c.bridge.data.config?.server}/v2/anchors${c.path}`, {
      method: c.method,
      headers: {
        authorization: `Bearer ${await ledgerToken(c.ledger, c.bridge.data.handle, c.key)}`,
        ...(c.client ? { 'x-forwarded-authorization': c.client } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
      },
      body: c.body === undefined ? undefined : JSON.stringify(c.body),
      signal: AbortSignal.timeout(30_000),
    })
    status = res.status
    text = await res.text()
  } catch {
    throw unexpected()
  }
  let body: any
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  const invalid = () => new LedgerError(502, 'forward.invalid-response', `Invalid response from bridge ${c.bridge.data.handle}`)
  // Recorded: a 401 is the ledger's own failure, not the bridge's answer.
  if (status === 401 || status === 403) throw unexpected()
  if (status < 200 || status >= 300) {
    const d = body?.data
    if (typeof d?.reason !== 'string') throw invalid()
    throw new ForwardedError(status, d.reason, d.detail, d.custom, Array.isArray(body.meta?.proofs) ? body.meta.proofs : [])
  }
  if (!body || typeof body !== 'object' || body.data === undefined || (list && !Array.isArray(body.data))) throw invalid()
  checkSigned(body)
  if (list) for (const item of body.data) checkSigned(item)
  return body
}

// A record as the ledger itself would accept it: the hash is the data's, every proof signs it.
// Recorded: `Invalid dto hash: <hash>` (`undefined` for none), `Invalid dto signature: <the proof>`.
export function checkSigned(r: any) {
  if (typeof r?.hash !== 'string' || r.hash !== hashData(r.data)) throw new LedgerError(422, 'crypto.hash-invalid', `Invalid dto hash: ${r?.hash}`)
  for (const p of r.meta?.proofs ?? [])
    if (p.digest !== digestFor(r.hash, p.custom) || !verifyDigest(p.digest, p.public, p.result))
      throw new LedgerError(422, 'crypto.signature-invalid', `Invalid dto signature: ${canonical(p)}`)
}
