// The request journal (`GET /system/requests`; spec: listRequests, readRequest). Each
// request addressed to a ledger becomes a `$req` record: who called (`source`), the
// ledger (`target`), the record and the action, and the request and response as sent,
// with the bearer token redacted.
//
// Recorded (ledgers): the public reference has journaling switched off and answers
// `404 Journaling is not enabled`; our server does the same unless it is started with
// journaling on (OPEN_LEDGER_JOURNAL). The shape of an entry is the spec's example,
// and the record and action names are the SDK's (`RequestRecord`, `RequestAction`).

/** Path segment → the record name a request entry uses. */
const RECORDS: Record<string, string> = {
  ledger: 'ledger',
  symbols: 'symbol',
  wallets: 'wallet',
  intents: 'intent',
  signers: 'signer',
  circles: 'circle',
  policies: 'policy',
  bridges: 'bridge',
  schemas: 'schema',
  effects: 'effect',
  anchors: 'anchor',
  domains: 'domain',
  reports: 'report',
}

/** A path's own sub-resource → the record suffix and the action per method. */
const SUBS: Record<string, { suffix: string; actions: Record<string, string> }> = {
  proofs: { suffix: '-proof', actions: { POST: 'create' } },
  changes: { suffix: '-change', actions: { GET: 'query' } },
  access: { suffix: '-access', actions: { POST: 'check' } },
  balances: { suffix: '', actions: { GET: 'read-balance' } },
  limits: { suffix: '', actions: { GET: 'read-limit' } },
  drop: { suffix: '', actions: { POST: 'drop' } },
  activate: { suffix: '', actions: { POST: 'activate' } },
  signers: { suffix: '-signer', actions: { GET: 'query-signer', POST: 'assign-signer', DELETE: 'remove-signer' } },
  factors: { suffix: '', actions: {} },
  anchors: { suffix: '', actions: { POST: 'lookup', GET: 'query' } },
}

const ACTIONS: Record<string, string> = { POST: 'create', PUT: 'update', DELETE: 'drop' }

/**
 * What a request is about: `record` (`wallet`, or `wallet:w1` for one record) and
 * `action`. A factor is `signer-factor`; `/ledger` is the ledger itself.
 */
export function describe(method: string, url: string): { record: string; action: string } {
  const parts = url.split('?')[0].replace(/^\/api\/v2\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const [kind, id, sub, subId] = parts
  if (kind === 'ledger') {
    if (id && SUBS[id]) return { record: `ledger${SUBS[id].suffix}`, action: SUBS[id].actions[method] ?? (id === 'changes' ? 'read' : method.toLowerCase()) }
    return { record: 'ledger', action: method === 'GET' ? 'read' : (ACTIONS[method] ?? method.toLowerCase()) }
  }
  if (kind === 'signers' && sub === 'factors') {
    const one = subId ? `signer-factor:${subId}` : 'signer-factor'
    return { record: one, action: method === 'GET' ? (subId ? 'read' : 'query') : (ACTIONS[method] ?? 'create') }
  }
  const record = RECORDS[kind] ?? kind
  if (!id) return { record, action: method === 'GET' ? 'query' : (ACTIONS[method] ?? method.toLowerCase()) }
  if (!sub) return { record: `${record}:${id}`, action: method === 'GET' ? 'read' : (ACTIONS[method] ?? method.toLowerCase()) }
  const s = SUBS[sub]
  if (!s) return { record: `${record}:${id}`, action: method.toLowerCase() }
  const action = s.actions[method] ?? (sub === 'changes' && subId ? 'read' : method.toLowerCase())
  return { record: `${record}${s.suffix}:${id}`, action: sub === 'changes' && subId ? 'read' : action }
}

/** Request headers as journaled: the bearer token is never kept. */
export function redact(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(headers)) out[k] = k.toLowerCase() === 'authorization' ? '[REDACTED]' : v
  return out
}
