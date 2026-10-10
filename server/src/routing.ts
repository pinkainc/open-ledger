// Address resolution and wallet routes (docs: about-wallets; recorded in `routes`).
//
// An address `schema:handle@parent` that is no wallet resolves to the first wallet up
// the hierarchy `schema:handle@parent → schema@parent → parent → schema`; a step counts
// only when all its parts are present.
//
// Routes are per wallet. `debit` (an input route) applies where the wallet is a
// transfer's source; `credit`, `forward` and `accept` (output routes) where it is a
// transfer's or an issue's target. The first route of the group whose filter matches
// wins; a wallet with routes of a group but no match refuses the claim. Following
// `debit`/`credit` targets is repeated up to MAX_DEPTH, and a cycle is refused.
import type { Store, StoredRecord } from './store.js'
import { matches, parseQuery } from './query.js'

export const MAX_DEPTH = 3

export class RoutingError {
  constructor(readonly detail: string) {}
}

/** The candidate wallet handles for an address, most specific first. */
export function hierarchy(address: string): string[] {
  const colon = address.indexOf(':')
  const schema = colon > 0 ? address.slice(0, colon) : undefined
  const rest = colon > 0 ? address.slice(colon + 1) : address
  const at = rest.lastIndexOf('@')
  const parent = at >= 0 ? rest.slice(at + 1) : undefined
  const out = [address]
  if (schema && parent) out.push(`${schema}@${parent}`)
  if (parent) out.push(parent)
  if (schema) out.push(schema)
  return [...new Set(out.filter(Boolean))]
}

export async function resolveAddress(tx: Store, ledger: string, address: string): Promise<StoredRecord | undefined> {
  for (const h of hierarchy(address)) {
    const w = await tx.get(ledger, 'wallets', h)
    if (w) return w
  }
  return undefined
}

// A route filter names claim fields by path (`symbol.handle`, `amount`) and the intent
// under `ctx.intent`; a value is an equality or an object of query operators.
export function filterMatches(filter: Record<string, unknown> | undefined, claim: unknown, intent: unknown): boolean {
  if (!filter) return true
  const query: Record<string, unknown> = {}
  for (const [path, cond] of Object.entries(filter)) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).every((k) => k.startsWith('$')))
      for (const [op, v] of Object.entries(cond)) query[`${path}.${op}`] = v
    else query[path] = cond
  }
  return matches({ ...(claim as object), ctx: { intent } }, parseQuery(query))
}

export type Routed = { wallet: StoredRecord; forward?: string }

const INPUT = ['debit']
const OUTPUT = ['credit', 'forward', 'accept']

/**
 * The wallet a claim's source or target ends up at. Throws RoutingError with the
 * reference's wording where it was recorded.
 */
export async function route(tx: Store, ledger: string, intent: StoredRecord, claim: any, side: 'Source' | 'Target'): Promise<Routed | undefined> {
  const address: string = (side === 'Source' ? claim.source : claim.target).handle
  const first = await resolveAddress(tx, ledger, address)
  if (!first) return undefined
  const input = side === 'Source'
  if (input ? claim.action !== 'transfer' : !['transfer', 'issue'].includes(claim.action)) return { wallet: first }

  let wallet = first
  const seen = new Set([wallet.data.handle])
  for (let depth = 0; ; depth++) {
    const routes = ((wallet.data.routes ?? []) as any[]).filter((r) => (input ? INPUT : OUTPUT).includes(r.action))
    if (!routes.length) return { wallet }
    const r = routes.find((r) => filterMatches(r.filter, claim, intent))
    if (!r) throw new RoutingError(`No matching ${input ? 'in' : 'out'} route found for intent ${intent.data.handle}.`)
    if (r.action === 'accept') return { wallet }
    if (r.action === 'forward') return { wallet, forward: r.target }
    const next = await resolveAddress(tx, ledger, r.target)
    // Recorded (routes2): names the route's target and the wallet whose route it is.
    if (!next)
      throw new RoutingError(`${input ? 'Debit' : 'Credit'} routed wallet not resolved for the address ${r.target} - does not resolve to any existing wallet. Parent wallet: ${wallet.data.handle}`)
    if (next.data.handle === wallet.data.handle) return { wallet }
    if (seen.has(next.data.handle)) throw new RoutingError(`${input ? 'Debit' : 'Credit'} routing cycle detected for the address ${address}.`)
    // Recorded (routes2): three hops resolve, a fourth is refused with the claim's wallets.
    if (depth + 1 > MAX_DEPTH)
      throw new RoutingError(
        `Max wallet routing depth reached for intent ${intent.data.handle}. Original source wallet: "${claim.source?.handle ?? ''}", original target wallet: "${claim.target?.handle ?? ''}".`,
      )
    seen.add(next.data.handle)
    wallet = next
  }
}
