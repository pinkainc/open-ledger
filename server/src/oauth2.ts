// Tokens for bridges with an `oauth2` secure rule (about-bridges, "Oauth2"). The token
// endpoint gets Basic `clientId:clientSecret` and a form body
// `grant_type=client_credentials[&scope=…]`, and answers `access_token` with an
// optional `expires_in`.
//
// The docs promise a cache the reference does not have (recorded, secure: it asked
// for a token before every call, `expires_in: 3600` or not). We keep one, as an
// optimisation invisible on the API. How long a token lives, as the docs rank it:
// a JWT's `exp`; else `expires_in`; a JWT with neither never expires; anything else
// is used once. A token living less than 60 s is not kept, and a kept one is
// dropped 30 s before it expires, so a call never leaves with a token about to lapse.
import { createHash } from 'node:crypto'

export type OAuth2Rule = { clientId: string; clientSecret: string; tokenUrl: string; scope?: string }

const MIN_LIFETIME_MS = 60_000
const MARGIN_MS = 30_000

export class OAuth2Tokens {
  private readonly kept = new Map<string, { token: string; until: number }>()

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async token(rule: OAuth2Rule): Promise<string> {
    // The secret is part of the key (hashed), so a rotated secret asks anew.
    const key = createHash('sha256').update(JSON.stringify([rule.tokenUrl, rule.clientId, rule.clientSecret, rule.scope ?? null])).digest('hex')
    const hit = this.kept.get(key)
    if (hit && hit.until > this.clock()) return hit.token
    this.kept.delete(key)
    const asked = this.clock()
    const { token, expiresIn } = await this.request(rule)
    const lifetime = lifetimeMs(token, expiresIn, asked)
    if (lifetime >= MIN_LIFETIME_MS) this.kept.set(key, { token, until: asked + lifetime - MARGIN_MS })
    return token
  }

  /** Forget a token, e.g. after the bridge refused it. */
  clear() {
    this.kept.clear()
  }

  private async request(rule: OAuth2Rule) {
    const body = new URLSearchParams({ grant_type: 'client_credentials', ...(rule.scope ? { scope: rule.scope } : {}) })
    const res = await this.fetchFn(rule.tokenUrl, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${rule.clientId}:${rule.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    const json: any = await res.json().catch(() => undefined)
    if (!res.ok || typeof json?.access_token !== 'string') throw new Error(`OAuth2 token request to ${rule.tokenUrl} failed with status ${res.status}`)
    return { token: json.access_token as string, expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined }
  }
}

/** How long a token may be used, in ms from `now`: Infinity for ever, 0 for once. */
export function lifetimeMs(token: string, expiresIn: number | undefined, now: number): number {
  const claims = jwtClaims(token)
  if (claims && typeof claims.exp === 'number') return claims.exp * 1000 - now
  if (expiresIn !== undefined) return expiresIn * 1000
  return claims ? Infinity : 0
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' ? claims : undefined
  } catch {
    return undefined
  }
}
