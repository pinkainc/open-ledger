// List filters (docs: reference/about-queries). Query parameters name a field path
// and an optional operator, `data.handle.$eq=x` or `data.handle=x`; every filter must
// match. The SDK encodes arrays with brackets: `data.record.$in[0]=any&…$in[1]=wallet`.
//
// A path segment that meets an array fans out over its items ("any element"), unless
// it is a numeric index (`data.claims.0.amount`). Query values arrive as strings and
// are compared as the field's own type: a number field against Number(value).

const OPERATORS = new Set(['$eq', '$gt', '$gte', '$lt', '$lte', '$in', '$ne', '$nin', '$regex'])
const IGNORED = /^page[.[]/

export type Filter = { path: string[]; op: string; value: unknown }
export type Query = { filters: Filter[]; text?: string }

export function parseQuery(query: Record<string, unknown>): Query {
  const byKey = new Map<string, Filter>()
  let text: string | undefined
  for (const [raw, value] of Object.entries(query ?? {})) {
    if (IGNORED.test(raw)) continue
    if (raw === '$plainTextQuery') {
      text = String(value)
      continue
    }
    // `a.b.$in[0]`, `a.b.$in[]`, `a.b.$in`, `a.b`
    const m = /^(.*?)(?:\.(\$[a-zA-Z]+))?(?:\[(\d*)\])?$/.exec(raw)!
    const [, path, op = '$eq'] = m
    if (!OPERATORS.has(op) || !path) continue
    const key = `${path} ${op}`
    const values = Array.isArray(value) ? value : [value]
    if (op === '$in' || op === '$nin') {
      const f = byKey.get(key) ?? { path: path.split('.'), op, value: [] as unknown[] }
      ;(f.value as unknown[]).push(...values)
      byKey.set(key, f)
    } else byKey.set(key, { path: path.split('.'), op, value: values[0] })
  }
  return { filters: [...byKey.values()], text }
}

/** Every value at `path`, fanning out over arrays. */
function valuesAt(node: unknown, path: string[]): unknown[] {
  if (path.length === 0) return Array.isArray(node) ? [node, ...node] : [node]
  if (node == null) return []
  const [head, ...rest] = path
  if (Array.isArray(node)) {
    if (/^\d+$/.test(head)) return valuesAt(node[Number(head)], rest)
    return node.flatMap((item) => valuesAt(item, path))
  }
  if (typeof node !== 'object') return []
  return valuesAt((node as Record<string, unknown>)[head], rest)
}

// A query string compared with a field of another type takes the field's type.
function coerce(q: unknown, field: unknown): unknown {
  if (typeof q !== 'string') return q
  if (typeof field === 'number') return q.trim() !== '' && !Number.isNaN(Number(q)) ? Number(q) : q
  if (typeof field === 'boolean') return q === 'true' ? true : q === 'false' ? false : q
  if (field === null) return q === 'null' ? null : q
  return q
}

function same(field: unknown, q: unknown) {
  const v = coerce(q, field)
  if (typeof field === 'object' && field !== null) return JSON.stringify(field) === (typeof q === 'string' ? q : JSON.stringify(q))
  return field === v
}

function compare(field: unknown, q: unknown): number | undefined {
  const v = coerce(q, field)
  if (typeof field === 'number' && typeof v === 'number') return field - v
  if (typeof field === 'string' && typeof v === 'string') return field < v ? -1 : field > v ? 1 : 0
  return undefined
}

function test(f: Filter, fields: unknown[]): boolean {
  const any = (p: (x: unknown) => boolean) => fields.some(p)
  switch (f.op) {
    case '$eq':
      return any((x) => same(x, f.value))
    case '$ne':
      return !any((x) => same(x, f.value))
    case '$in':
      return any((x) => (f.value as unknown[]).some((v) => same(x, v)))
    case '$nin':
      return !any((x) => (f.value as unknown[]).some((v) => same(x, v)))
    case '$regex': {
      const re = new RegExp(String(f.value))
      return any((x) => typeof x === 'string' && re.test(x))
    }
    default: {
      const ok = { $gt: (c: number) => c > 0, $gte: (c: number) => c >= 0, $lt: (c: number) => c < 0, $lte: (c: number) => c <= 0 }[f.op]!
      return any((x) => {
        const c = compare(x, f.value)
        return c !== undefined && ok(c)
      })
    }
  }
}

// Whole words of an intent (docs): handle, ledger, schema, status, and per claim the
// action, symbol, and source/target addresses — each address also by its parts
// `schema:handle@domain` → handle, domain, handle@domain.
function words(record: any): Set<string> {
  const out = new Set<string>()
  const add = (s: unknown) => typeof s === 'string' && s && out.add(s.toLowerCase())
  const address = (a: unknown) => {
    const s = typeof a === 'string' ? a : (a as any)?.handle
    if (typeof s !== 'string') return
    add(s)
    const local = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s
    add(local)
    const at = local.lastIndexOf('@')
    if (at >= 0) {
      add(local.slice(0, at))
      add(local.slice(at + 1))
    }
  }
  const d = record?.data ?? {}
  ;[d.handle, d.ledger, d.schema, record?.meta?.status].forEach(add)
  for (const c of Array.isArray(d.claims) ? d.claims : []) {
    add(c?.action)
    add(typeof c?.symbol === 'string' ? c.symbol : c?.symbol?.handle)
    address(c?.source)
    address(c?.target)
  }
  return out
}

export function matches(record: unknown, q: Query): boolean {
  if (q.text !== undefined && !words(record).has(q.text.toLowerCase())) return false
  return q.filters.every((f) => test(f, valuesAt(record, f.path)))
}
