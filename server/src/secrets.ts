// Secrets a record refers to as `{{ secret.<name> }}` (bridge `secure` rules). The
// client sends each value once, in `meta.secret` of the create or update; the ledger
// keeps it sealed and never serves it (recorded, secure). Sealing is AES-256-GCM under
// a server master key, so a database dump alone does not reveal them.
//
// The master key comes from OPEN_LEDGER_MASTER_KEY (32 bytes, base64). Without it the
// server makes one per process: fine in memory, but secrets sealed under it cannot be
// opened after a restart — main.ts warns when that matters (Postgres).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const SECRET_REF = /^\{\{ secret\.([A-Za-z]+[A-Za-z0-9]*) \}\}$/

export class SecretBox {
  private readonly key: Buffer
  readonly ephemeral: boolean

  constructor(masterKey = process.env.OPEN_LEDGER_MASTER_KEY) {
    this.ephemeral = !masterKey
    this.key = masterKey ? Buffer.from(masterKey, 'base64') : randomBytes(32)
    if (this.key.length !== 32) throw new Error('OPEN_LEDGER_MASTER_KEY must be 32 bytes, base64')
  }

  /** `v1.<iv>.<tag>.<ciphertext>`, base64 parts. `context` binds the value to where it belongs. */
  seal(plain: string, context: string): string {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    c.setAAD(Buffer.from(context))
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.')
  }

  open(sealed: string, context: string): string {
    const [v, iv, tag, body] = sealed.split('.')
    if (v !== 'v1') throw new Error(`unknown secret format ${v}`)
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    d.setAAD(Buffer.from(context))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8')
  }
}

/** Names of the secrets a value refers to, anywhere inside it. */
export function secretRefs(x: unknown, out = new Set<string>()): Set<string> {
  if (typeof x === 'string') {
    const m = x.match(SECRET_REF)
    if (m) out.add(m[1])
  } else if (Array.isArray(x)) for (const v of x) secretRefs(v, out)
  else if (x && typeof x === 'object') for (const v of Object.values(x)) secretRefs(v, out)
  return out
}

/** Replaces every reference in a value by its resolved secret. */
export function resolveRefs<T>(x: T, value: (name: string) => string): T {
  if (typeof x === 'string') {
    const m = x.match(SECRET_REF)
    return (m ? value(m[1]) : x) as T
  }
  if (Array.isArray(x)) return x.map((v) => resolveRefs(v, value)) as T
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, resolveRefs(v, value)])) as T
  return x
}
