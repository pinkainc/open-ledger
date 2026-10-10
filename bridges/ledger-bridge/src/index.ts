// A bridge between two Minka-compatible ledgers.
//
// The upstream ledger (a clearing house, as in connecting-systems/cross-ledger-payments)
// sees this adapter as the bridge of one wallet, e.g. a bank's `mint`. Every debit or
// credit of an address in that wallet (`account:1001@mint`, or `mint` itself) arrives
// here as a two-phase-commit call, and the adapter carries it out as intents on the
// downstream ledger (the bank's core), signed with its own key:
//
//   prepare debit   transfer  account → transit      the money is held
//   commit debit    destroy   transit                it has left the bank
//   abort debit     transfer  transit → account      only if the prepare completed
//   prepare credit  the account must exist downstream
//   commit credit   issue     → account              it has entered the bank
//   abort credit    nothing
//
// So money crossing the boundary is destroyed on one side and issued on the other, and
// the downstream supply always equals the upstream wallet's balance. Downstream intent
// handles are the upstream entry handle plus the phase (`cre_…-commit`), which makes a
// repeated call idempotent: the intent already exists and is only waited for.
//
// No loops: the adapter only ever writes downstream, and nothing downstream calls it.
// Every wait is bounded (`attempts`), also a commit, which the protocol says must not
// fail: after the last attempt it is logged and left for an operator.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { LedgerSdk } from '@minka/ledger-sdk'
import { createHash, createPublicKey, verify } from 'node:crypto'
import stringify from 'safe-stable-stringify'

export type KeyPair = { public: string; secret: string; format?: string }
export type LedgerRef = { server: string; ledger: string }

export type LedgerBridgeOptions = {
  /** The bridge's handle upstream; its key signs the proofs there and the intents downstream. */
  handle: string
  keyPair: KeyPair
  /** The ledger that calls this bridge; proofs are sent to it. */
  upstream: LedgerRef
  /** The ledger whose intents carry the calls out. */
  downstream: LedgerRef
  /** The upstream wallet this bridge serves: `x@<wallet>` maps to downstream wallet `x`. */
  wallet: string
  /** Downstream wallet for the upstream wallet itself (default `treasury`). */
  treasury?: string
  /** Downstream wallet holding debits between prepare and commit (default `transit`). */
  transit?: string
  /** Upstream signer keys whose proof a call must carry; read from the ledger's `system` signer when absent. */
  trusted?: string[]
  /** Polls of a downstream intent before giving up, 250 ms apart (default 240, one minute). */
  attempts?: number
  log?: (line: Record<string, unknown>) => void
}

type Entry = { handle: string; schema: 'debit' | 'credit'; amount: number; symbol: { handle: string }; source?: { handle: string }; target?: { handle: string }; intent: any }
type Phase = 'prepare' | 'commit' | 'abort'

const hashData = (data: unknown) => createHash('sha256').update(stringify(data) ?? '').digest('hex')
const SPKI = Buffer.from('302a300506032b6570032100', 'hex')
function verifyProof(hash: string, p: any, keys: Set<string>) {
  if (!keys.has(p?.public)) return false
  const digest = createHash('sha256').update(hash + (p.custom ? stringify(p.custom) : '')).digest('hex')
  if (digest !== p.digest) return false
  try {
    return verify(null, Buffer.from(digest, 'hex'), createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(p.public, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(p.result, 'base64'))
  } catch {
    return false
  }
}

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class LedgerBridge {
  private up: any
  private down: any
  private trusted?: Set<string>
  /** One run per entry and phase: a repeated call joins the run already under way. */
  private runs = new Map<string, Promise<void>>()
  /** Entries seen in a prepare, for the commit or abort that names them by handle. */
  private entries = new Map<string, Entry>()
  private server?: Server
  readonly transit: string
  readonly treasury: string

  constructor(readonly o: LedgerBridgeOptions) {
    const k = o.keyPair
    this.up = new LedgerSdk({ server: o.upstream.server, ledger: o.upstream.ledger, secure: { iss: o.handle, sub: `bridge:${o.handle}`, aud: o.upstream.ledger, exp: 3600, createHsh: false, kid: k.public, keyPair: k } as any })
    this.down = new LedgerSdk({ server: o.downstream.server, ledger: o.downstream.ledger, secure: { iss: k.public, sub: `signer:${k.public}`, aud: o.downstream.ledger, exp: 3600, createHsh: false, kid: k.public, keyPair: k } as any })
    this.transit = o.transit ?? 'transit'
    this.treasury = o.treasury ?? 'treasury'
    if (o.trusted) this.trusted = new Set(o.trusted)
  }

  private log(line: Record<string, unknown>) {
    this.o.log?.(line)
  }

  /** The downstream wallet of an upstream address, or undefined when it is not this bridge's. */
  account(address: string): string | undefined {
    if (address === this.o.wallet) return this.treasury
    const suffix = `@${this.o.wallet}`
    return address.endsWith(suffix) ? address.slice(0, -suffix.length) : undefined
  }

  private async trustedKeys() {
    if (!this.trusted) {
      const r: any = await this.up.signer.read('system')
      this.trusted = new Set([r.signer?.public ?? r.response?.data?.data?.public].filter(Boolean))
    }
    return this.trusted
  }

  /** Whether the call body is the entry as the upstream ledger signed it. */
  async authentic(body: any) {
    if (!body?.data || body.hash !== hashData(body.data)) return false
    const keys = await this.trustedKeys()
    return (body.meta?.proofs ?? []).some((p: any) => verifyProof(body.hash, p, keys))
  }

  async listen(port: number, host = '127.0.0.1') {
    this.server = createServer(async (req, res) => {
      const text = await read(req)
      let body: any
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {}
      const m = (req.url ?? '').match(/\/v2\/(debits|credits)(?:\/([^/]+)\/(commit|abort))?$/)
      if (req.method === 'PUT' && /\/v2\/intents\//.test(req.url ?? '')) {
        // Status notifications of the upstream intent: nothing to do.
        this.log({ req: { method: req.method, url: req.url, headers: req.headers, body }, res: { status: 200 } })
        res.statusCode = 200
        return res.end()
      }
      if (!m || req.method !== 'POST') {
        this.log({ req: { method: req.method, url: req.url, headers: req.headers, body }, res: { status: 404 } })
        res.statusCode = 404
        return res.end()
      }
      const status = (code: number) => {
        this.log({ req: { method: req.method, url: req.url, headers: req.headers, body }, res: { status: code } })
        res.statusCode = code
        res.end()
      }
      let ok = false
      try {
        ok = await this.authentic(body)
      } catch (e: any) {
        this.log({ error: 'signer system unreadable', detail: e?.message })
      }
      if (!ok) return status(401)
      const phase: Phase = (m[3] as Phase) ?? 'prepare'
      // A commit or abort carries only the entry's handle and the intent.
      const entry = phase === 'prepare' ? (body.data as Entry) : this.entry(m[2], m[1] === 'debits' ? 'debit' : 'credit', body.data.intent)
      if (!entry) return status(404)
      if (phase === 'prepare') this.entries.set(entry.handle, entry)
      else entry.intent = body.data.intent
      status(202)
      this.handle(entry, phase)
    })
    await new Promise<void>((r) => this.server!.listen(port, host, () => r()))
    return (this.server.address() as any).port as number
  }

  close() {
    return new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }

  /**
   * The entry a commit or abort names: from its prepare, or, after a restart, from the
   * intent, whose proofs record each entry (`schema`, `amount`, `symbol`, the claims it
   * comes from in `inputs`).
   */
  entry(handle: string, schema: 'debit' | 'credit', intent: any): Entry | undefined {
    const seen = this.entries.get(handle)
    if (seen) return { ...seen }
    const p = (intent?.meta?.proofs ?? []).find((x: any) => x.custom?.handle === handle)?.custom
    const claim = intent?.data?.claims?.[p?.inputs?.[0]]
    if (!p || !claim) return undefined
    const named = schema === 'debit' ? claim.source : claim.target
    const address = typeof named === 'string' ? { handle: named } : named
    return { handle, schema, amount: p.amount, symbol: { handle: p.symbol }, [schema === 'debit' ? 'source' : 'target']: address, intent }
  }

  /** Carries out one call; repeated calls for the same entry and phase share one run. */
  handle(entry: Entry, phase: Phase) {
    const key = `${entry.handle}:${phase}`
    let run = this.runs.get(key)
    if (!run) {
      run = this.run(entry, phase).catch((e) => this.log({ entry: entry.handle, phase, error: e?.message ?? String(e) }))
      this.runs.set(key, run)
    }
    return run
  }

  /** Every run started so far, settled; for tests and shutdown. */
  async idle() {
    while (true) {
      const n = this.runs.size
      await Promise.all(this.runs.values())
      if (this.runs.size === n) return
    }
  }

  private async run(e: Entry, phase: Phase) {
    const address = (e.schema === 'debit' ? e.source : e.target)?.handle ?? ''
    const account = this.account(address)
    const symbol = e.symbol.handle
    const h = (p: string) => `${e.handle}-${p}`
    if (!account) return this.report(e, { status: phase === 'prepare' ? 'failed' : phase === 'commit' ? 'committed' : 'aborted', ...(phase === 'prepare' ? { reason: 'bridge.account-not-found', detail: `Address ${address} is not served by ${this.o.handle}.` } : {}) })

    if (e.schema === 'debit') {
      if (phase === 'prepare') {
        const r = await this.intent(h('prepare'), [{ action: 'transfer', source: { handle: account }, target: { handle: this.transit }, symbol: { handle: symbol }, amount: e.amount }])
        if (r.status === 'completed') return this.report(e, { status: 'prepared', coreId: h('prepare') })
        return this.report(e, { status: 'failed', reason: r.reason === 'core.limit-exceeded' ? 'bridge.account-insufficient-balance' : 'bridge.entry-rejected', detail: r.detail ?? `Intent ${h('prepare')} ${r.status}.` })
      }
      if (phase === 'commit') {
        const r = await this.intent(h('commit'), [{ action: 'destroy', source: { handle: this.transit }, symbol: { handle: symbol }, amount: e.amount }])
        if (r.status !== 'completed') throw new Error(`commit ${h('commit')} ${r.status}: ${r.detail ?? ''}`)
        return this.report(e, { status: 'committed', coreId: h('commit') })
      }
      // Abort: undo the hold only if it happened; wait for a prepare still under way.
      await this.runs.get(`${e.handle}:prepare`)
      const prepared = await this.status(h('prepare'))
      if (prepared === 'completed') {
        const r = await this.intent(h('abort'), [{ action: 'transfer', source: { handle: this.transit }, target: { handle: account }, symbol: { handle: symbol }, amount: e.amount }])
        if (r.status !== 'completed') throw new Error(`abort ${h('abort')} ${r.status}: ${r.detail ?? ''}`)
        return this.report(e, { status: 'aborted', coreId: h('abort') })
      }
      return this.report(e, { status: 'aborted' })
    }

    if (phase === 'prepare') {
      try {
        await this.down.wallet.read(account)
      } catch {
        return this.report(e, { status: 'failed', reason: 'bridge.account-not-found', detail: `Account ${account} not found.` })
      }
      return this.report(e, { status: 'prepared', coreId: h('prepare') })
    }
    if (phase === 'commit') {
      const r = await this.intent(h('commit'), [{ action: 'issue', target: { handle: account }, symbol: { handle: symbol }, amount: e.amount }])
      if (r.status !== 'completed') throw new Error(`commit ${h('commit')} ${r.status}: ${r.detail ?? ''}`)
      return this.report(e, { status: 'committed', coreId: h('commit') })
    }
    return this.report(e, { status: 'aborted' })
  }

  private async status(handle: string): Promise<string | undefined> {
    try {
      const r: any = await this.down.intent.read(handle)
      return r.response.data.meta.status
    } catch {
      return undefined
    }
  }

  /** Creates a downstream intent (or finds the one a repeated call made) and waits for it to finish. */
  private async intent(handle: string, claims: unknown[]): Promise<{ status: string; reason?: string; detail?: string }> {
    try {
      await this.down.intent.init().data({ handle, claims } as any).hash().sign([{ keyPair: this.o.keyPair }]).send()
      this.log({ downstream: handle, claims })
    } catch (e: any) {
      // Already made by an earlier call; anything else shows in the reads below.
      const res = e?.custom?.causedBy?.response
      this.log({ downstream: handle, answer: res?.status, error: res?.data?.reason ?? e?.message })
    }
    for (let i = 0; i < (this.o.attempts ?? 240); i++) {
      try {
        const r: any = (await this.down.intent.read(handle)).response.data
        const status = r.meta.status
        if (status === 'completed' || status === 'rejected') {
          const why = [...(r.meta.proofs ?? [])].reverse().find((p: any) => p.custom?.reason)?.custom
          return { status, reason: why?.reason, detail: why?.detail }
        }
      } catch {}
      await sleep(250)
    }
    return { status: 'timeout' }
  }

  /** Signs the outcome onto the upstream intent, as @minka/bridge-sdk does. */
  private async report(e: Entry, custom: Record<string, unknown>) {
    const proof = { handle: e.handle, ...custom }
    try {
      const res = await this.up.intent.from(e.intent).sign([{ keyPair: this.o.keyPair, custom: { ...proof, moment: new Date().toISOString() } }]).send()
      this.log({ entry: e.handle, proof, answer: res.response.status })
    } catch (err: any) {
      const res = err?.custom?.causedBy?.response
      this.log({ entry: e.handle, proof, answer: res?.status, error: res?.data?.reason ?? err?.message })
    }
  }
}
