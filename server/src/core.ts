// Intent processing for intents whose only participant is the ledger itself (L1).
//
// The proof trail an intent accumulates is part of the contract — clients read it to
// learn what happened — so its sequence follows the reference ledger exactly:
//
//   created (client) → pending → pending+luid → resolved entries → [core prepared per
//   entry] → prepared → committed "awaiting-clearance" → cleared → completed
//
// or, on failure, … → failed {reason, detail} → aborted → rejected.
//
// Claims need permissions (about-intents, "Intent signatures"): `spend` on a debited
// wallet, `issue` / `destroy` on the symbol, `limit` on a limited wallet, granted to
// the intent's signers by the access rules. They are checked after resolution. An
// intent whose signers lack one is not refused: it stays `pending` after its resolved
// entries (recorded, access4) until more signatures arrive or it expires — the expiry
// job then rejects it with `core.intent-expired`.
//
// How we get there is ours. The reference runs these steps as separate asynchronous
// stages with intermediate states visible to readers; here one intent is processed in
// a single transaction that serialises the ledger, so balances can never be observed
// half-moved and a crash leaves the intent `pending`, to be picked up again on start.
import { customAlphabet } from 'nanoid'
import { serverProof, type KeyPair, type Proof } from './crypto.js'
import { newLuid } from './ids.js'
import type { BalanceRow, LimitRow, Store, StoredRecord } from './store.js'
import { hashData } from './crypto.js'
import type { AccessControl, Principal } from './access.js'
import { Bridges, type BridgeCall, type BridgeOptions } from './bridges.js'
import { createHash } from 'node:crypto'

const entryId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 17)

type LimitOp = { wallet: string; symbol: string; metric: string; amount: number }

type Entry = { schema: 'debit' | 'credit'; handle: string; wallet: string; symbol: string; amount: number; input: number; bridge?: string }

const FINAL = new Set(['completed', 'rejected'])

/** Calls to make once a transaction has committed. */
type Delivery = { order: 'sequential' | 'parallel'; calls: BridgeCall[] }

class Rejection {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {}
}

// Moments must be distinct and ordered within one trail, even when the clock does not
// advance between two proofs.
function clock() {
  let last = 0
  return () => {
    last = Math.max(Date.now(), last + 1)
    return new Date(last).toISOString()
  }
}

export type CoreOptions = {
  /**
   * Length of one minute of intent expiry, in ms. Only conformance runs change it, so
   * that a one-minute expiry recorded on the reference does not take a minute here.
   */
  minuteMs?: number
  bridges?: BridgeOptions
}

/** A claim permission: an action on one wallet or symbol. */
type Need = { action: string; record: 'wallet' | 'symbol'; handle: string }

export class Core {
  /** Access rules for claim permissions; set by the app that owns the rules. */
  access?: AccessControl
  readonly bridges: Bridges
  private readonly minuteMs: number
  private expiryTimer?: NodeJS.Timeout

  constructor(
    private readonly store: Store,
    { minuteMs = 60_000, bridges }: CoreOptions = {},
  ) {
    this.minuteMs = minuteMs
    this.bridges = new Bridges(bridges)
  }

  /** Process an intent after the current request has been answered. */
  schedule(ledger: string, handle: string, redrive = false) {
    setImmediate(() => void this.process(ledger, handle, redrive).catch((e) => console.error(`intent ${ledger}/${handle}:`, e)))
  }

  /**
   * Pick up intents a previous run left unfinished. Calls to bridges that were in
   * flight are sent again; bridges treat a repeat as a no-op.
   */
  async resume() {
    for (const l of await this.store.list('', 'ledgers'))
      for (const i of await this.store.list(l.data.handle, 'intents'))
        if (!FINAL.has(i.meta.status)) this.schedule(l.data.handle, i.data.handle, true)
  }

  close() {
    this.stopExpiry()
    this.bridges.close()
  }

  /**
   * Moves an intent as far as it can go now. Everything the intent has done is in
   * its proof trail, so the next step is read from there: this runs again whenever a
   * bridge reports, and after a restart.
   */
  async process(ledger: string, handle: string, redrive = false) {
    const calls: Delivery[] = []
    await this.store.transaction(ledger, async (tx) => {
      const intent = await tx.get(ledger, 'intents', handle)
      if (!intent || FINAL.has(intent.meta.status)) return
      const run = new Run(tx, ledger, intent, (await tx.getKey(ledger, 'system'))!, (await tx.getKey(ledger, 'core'))!)
      try {
        if (intent.meta.status === 'pending') await this.advancePending(run, calls, redrive)
        else if (intent.meta.status === 'committed') await this.advanceCommitted(run, calls, redrive)
        else if (intent.meta.status === 'aborted') await this.advanceAborted(run, calls, redrive)
      } catch (e) {
        if (!(e instanceof Rejection)) throw e
        reject(run.trail, run.stage, run.sign, run.now, e.reason, e.detail)
        intent.meta.status = 'rejected'
      }
      await run.finish()
    })
    await this.deliver(calls)
  }

  // pending: resolve, check permissions and limits, prepare. With bridged entries the
  // intent then waits for every bridge to report `prepared` (or one to report `failed`).
  private async advancePending(run: Run, calls: Delivery[], redrive: boolean) {
    const { tx, ledger, intent, trail } = run
    const earlier = resolvedEntries(intent)
    const { entries, limits } = await this.resolve(tx, ledger, intent, earlier)
    if (!earlier) {
      const t = run.now()
      for (const e of entries)
        trail.push(
          run.sign({
            amount: e.amount,
            ...(e.bridge ? { bridge: e.bridge } : {}),
            handle: e.handle,
            inputs: [e.input],
            moment: t,
            schema: e.schema,
            status: 'resolved',
            symbol: e.symbol,
            wallet: e.wallet,
          }),
        )
    }
    if (trail.length) run.stage('pending')
    if (!(await this.permitted(tx, ledger, intent))) return // waiting for signatures; nothing moves

    const bridged = bridgedEntries(intent.data.claims, entries)
    const debits = entries.filter((e) => e.schema === 'debit')
    if (!run.corePrepared()) {
      // Bridges get the intent as it was resolved, before the core's own prepare.
      const resolved = run.snapshot('pending')
      await this.checkLimits(tx, ledger, run.books, entries)
      // The ledger core takes part as a participant only when balances are spent.
      if (debits.length) {
        const tp = run.now()
        for (const e of entries) trail.push(serverProof(intent.hash, { handle: e.handle, moment: tp, schema: e.schema, status: 'prepared' }, run.core, 'core'))
        for (const e of debits) {
          await run.books.move(e.wallet, e.symbol, 'available', -e.amount, tp, true)
          await run.books.move(e.wallet, e.symbol, 'reserved', +e.amount, tp, true)
        }
      }
      if (bridged.length) {
        run.stage('pending')
        calls.push({ order: 'sequential', calls: await this.entryCalls(run, bridged, resolved) })
        return
      }
    } else if (redrive && bridged.length) {
      const waiting = bridged.filter((e) => !run.reported(e.handle, ['prepared', 'failed']))
      calls.push({ order: 'sequential', calls: await this.entryCalls(run, waiting, run.snapshot('pending')) })
    }

    if (bridged.length) {
      const failed = bridged.filter((e) => run.reported(e.handle, ['failed']))
      if (failed.length) {
        const names = [...new Set(failed.map((e) => e.bridge!))].join(', ')
        return this.abort(run, calls, bridged, 'core.bridge-prepare-failed', `Bridge(s) failed to process intent: ${names}`)
      }
      if (!bridged.every((e) => run.reported(e.handle, ['prepared']))) return
    }
    await this.commit(run, calls, entries, limits, bridged)
  }

  // prepared → committed: the ledger commits its own part at once; bridges are told to
  // commit and the intent completes when each has reported `committed`.
  private async commit(run: Run, calls: Delivery[], entries: Entry[], limits: LimitOp[], bridged: Entry[]) {
    const { tx, ledger, intent, trail } = run
    trail.push(run.sign({ moment: run.now(), status: 'prepared' }))
    run.stage('prepared')
    if (bridged.length) calls.push({ order: 'parallel', calls: await this.statusCalls(run, bridged, run.snapshot('prepared')) })
    run.stage('prepared', true)
    trail.push(run.sign({ detail: 'awaiting-clearance', moment: run.now(), status: 'committed' }))
    run.stage('committed', true)
    if (bridged.length) calls.push({ order: 'parallel', calls: await this.commandCalls(run, bridged, 'commit', run.snapshot('committed', true)) })

    const tc = run.now()
    for (const l of limits) {
      run.limitWrites.push(await this.limitRow(tx, ledger, l, run.system, tc))
      await run.books.touch(l.wallet, l.symbol, tc)
    }
    const debits = entries.filter((e) => e.schema === 'debit')
    for (const e of debits) await run.books.move(e.wallet, e.symbol, 'reserved', -e.amount, tc, true)
    for (const e of entries.filter((e) => e.schema === 'credit')) await run.books.move(e.wallet, e.symbol, 'available', +e.amount, tc, false)
    if (debits.length) {
      for (const e of entries) {
        // Clearance proofs by the core are bare: no `signer`, no `origin`.
        const { signer: _s, origin: _o, ...bare } = serverProof(intent.hash, { detail: 'cleared', handle: e.handle, moment: tc, schema: e.schema, status: 'committed' }, run.core, 'core')
        trail.push(bare as Proof)
      }
    } else {
      trail.push(run.sign({ coreId: intent.data.handle, detail: 'cleared', moment: tc, status: 'committed' }))
    }
    run.stage('committed', true)
    intent.meta.routed = true
    intent.meta.status = 'committed'
    if (!bridged.length) await this.complete(run, calls, bridged)
  }

  private async advanceCommitted(run: Run, calls: Delivery[], redrive: boolean) {
    const bridged = bridgedEntries(run.intent.data.claims, resolvedEntries(run.intent) ?? [])
    if (redrive) {
      const waiting = bridged.filter((e) => !run.reported(e.handle, ['committed']))
      calls.push({ order: 'parallel', calls: await this.commandCalls(run, waiting, 'commit', run.snapshot('committed', true)) })
    }
    if (bridged.every((e) => run.reported(e.handle, ['committed']))) await this.complete(run, calls, bridged)
  }

  private async complete(run: Run, calls: Delivery[], bridged: Entry[]) {
    run.trail.push(run.sign({ moment: run.now(), status: 'completed' }))
    run.stage('completed', true)
    run.intent.meta.status = 'completed'
    if (bridged.length) calls.push({ order: 'parallel', calls: await this.statusCalls(run, bridged, run.snapshot('completed', true)) })
  }

  // failed → aborted: bridges are told to abort (every bridged entry, the failing one
  // too, in reverse order) and the intent is rejected once each has reported `aborted`;
  // then the core releases its reservations.
  private async abort(run: Run, calls: Delivery[], bridged: Entry[], reason: string, detail: string) {
    run.trail.push(run.sign({ detail, moment: run.now(), reason, status: 'failed' }))
    run.stage('failed')
    run.trail.push(run.sign({ moment: run.now(), status: 'aborted' }))
    run.stage('aborted')
    run.intent.meta.status = 'aborted'
    if (bridged.length) calls.push({ order: 'sequential', calls: await this.commandCalls(run, [...bridged].reverse(), 'abort', run.snapshot('aborted')) })
    else await this.rejectAborted(run, calls, bridged)
  }

  private async advanceAborted(run: Run, calls: Delivery[], redrive: boolean) {
    const bridged = bridgedEntries(run.intent.data.claims, resolvedEntries(run.intent) ?? [])
    if (redrive) {
      const waiting = bridged.filter((e) => !run.reported(e.handle, ['aborted'])).reverse()
      calls.push({ order: 'sequential', calls: await this.commandCalls(run, waiting, 'abort', run.snapshot('aborted')) })
    }
    if (bridged.every((e) => run.reported(e.handle, ['aborted']))) await this.rejectAborted(run, calls, bridged)
  }

  private async rejectAborted(run: Run, calls: Delivery[], bridged: Entry[]) {
    const entries = resolvedEntries(run.intent) ?? []
    if (run.corePrepared()) {
      const ta = run.now()
      for (const e of entries) run.trail.push(serverProof(run.intent.hash, { handle: e.handle, moment: ta, schema: e.schema, status: 'aborted' }, run.core, 'core'))
      for (const e of entries.filter((e) => e.schema === 'debit')) {
        await run.books.move(e.wallet, e.symbol, 'reserved', -e.amount, ta, true)
        await run.books.move(e.wallet, e.symbol, 'available', +e.amount, ta, true)
      }
    }
    run.trail.push(run.sign({ moment: run.now(), status: 'rejected' }))
    run.stage('rejected')
    run.intent.meta.status = 'rejected'
    if (bridged.length) calls.push({ order: 'parallel', calls: await this.statusCalls(run, bridged, run.snapshot('rejected')) })
  }

  // ---- calls to bridges -----------------------------------------------------------

  private async server(tx: Store, ledger: string, bridge: string) {
    return (await tx.get(ledger, 'bridges', bridge))?.data.config?.server as string | undefined
  }

  private signed(run: Run, data: unknown) {
    const hash = hashData(data)
    return { hash, data, meta: { proofs: [serverProof(hash, { moment: run.now() }, run.system, 'system')] } }
  }

  // Prepare: the entry as a signed record, debits before credits. Observed: both
  // `source` and `target` of the claim, the claim index as `inputs`, and a `$ben` luid
  // that stays the same when the call is retried.
  private async entryCalls(run: Run, entries: Entry[], intent: unknown): Promise<BridgeCall[]> {
    const out: BridgeCall[] = []
    const claims: any[] = run.intent.data.claims
    for (const e of [...entries].sort((a, b) => (a.schema === b.schema ? 0 : a.schema === 'debit' ? -1 : 1))) {
      const server = await this.server(run.tx, run.ledger, e.bridge!)
      if (!server) continue
      const c = claims[e.input]
      const data = {
        handle: e.handle,
        luid: entryLuid(run.ledger, e.handle),
        schema: e.schema,
        ...(c.source ? { source: c.source } : {}),
        ...(c.target ? { target: c.target } : {}),
        symbol: c.symbol,
        amount: e.amount,
        inputs: [e.input],
        intent,
      }
      out.push({ bridge: e.bridge!, server, method: 'POST', path: `/${e.schema}s`, body: this.signed(run, data) })
    }
    return out
  }

  private async commandCalls(run: Run, entries: Entry[], action: 'commit' | 'abort', intent: unknown): Promise<BridgeCall[]> {
    const out: BridgeCall[] = []
    for (const e of entries) {
      const server = await this.server(run.tx, run.ledger, e.bridge!)
      if (server) out.push({ bridge: e.bridge!, server, method: 'POST', path: `/${e.schema}s/${e.handle}/${action}`, body: this.signed(run, { handle: e.handle, action, intent }) })
    }
    return out
  }

  // Status notifications go once to each bridge of the intent: on `prepared` and on the
  // final status (recorded; a rejected intent that never prepared gets only the last).
  private async statusCalls(run: Run, entries: Entry[], intent: any): Promise<BridgeCall[]> {
    const out: BridgeCall[] = []
    for (const bridge of new Set(entries.map((e) => e.bridge!))) {
      const server = await this.server(run.tx, run.ledger, bridge)
      if (server) out.push({ bridge, server, method: 'PUT', path: `/intents/${encodeURIComponent(run.intent.data.handle)}`, body: intent })
    }
    return out
  }

  // After the transaction: the calls go out in the background, in the order asked for.
  private async deliver(deliveries: Delivery[]) {
    for (const d of deliveries) {
      if (d.order === 'sequential') void this.bridges.inOrder(d.calls)
      else for (const c of d.calls) void this.bridges.deliver(c)
    }
  }

  /** Rejects pending intents older than their ledger's expiry threshold. */
  async expire() {
    const nowMs = Date.now()
    for (const l of await this.store.list('', 'ledgers')) {
      const minutes = Number(l.data.config?.['intent.expiryThresholdMinutes'])
      if (!(minutes > 0)) continue
      for (const i of await this.store.list(l.data.handle, 'intents')) {
        const created = createdMoment(i)
        if (i.meta.status !== 'pending' || created === undefined || nowMs - created <= minutes * this.minuteMs) continue
        await this.expireOne(l.data.handle, i.data.handle)
      }
    }
  }

  // An expired intent is aborted like one a bridge refused: bridges it involves are
  // told to abort, reservations are released, and it ends `rejected` (access4).
  private async expireOne(ledger: string, handle: string) {
    const calls: Delivery[] = []
    await this.store.transaction(ledger, async (tx) => {
      const intent = await tx.get(ledger, 'intents', handle)
      if (!intent || intent.meta.status !== 'pending') return
      const run = new Run(tx, ledger, intent, (await tx.getKey(ledger, 'system'))!, (await tx.getKey(ledger, 'core'))!)
      const bridged = run.corePrepared() ? bridgedEntries(intent.data.claims, resolvedEntries(intent) ?? []) : []
      await this.abort(run, calls, bridged, 'core.intent-expired', `Intent ${intent.data.handle} expired`)
      await run.finish()
    })
    await this.deliver(calls)
  }

  /** Runs `expire` periodically; the reference's job is not immediate either. */
  startExpiry(everyMs = Math.min(5_000, this.minuteMs / 4)) {
    this.stopExpiry()
    this.expiryTimer = setInterval(() => void this.expire().catch((e) => console.error('expiry:', e)), everyMs)
    this.expiryTimer.unref()
  }

  stopExpiry() {
    if (this.expiryTimer) clearInterval(this.expiryTimer)
  }

  // Every claim needs its permission from at least one of the intent's signers.
  private async permitted(tx: Store, ledger: string, intent: StoredRecord) {
    if (!this.access) return true
    const ledgerRecord = await tx.get('', 'ledgers', ledger)
    if (!ledgerRecord) return false
    const { keys, who } = await signersOf(tx, ledger, intent)
    for (const need of needsOf(intent.data.claims)) {
      const record = await tx.get(ledger, need.record === 'wallet' ? 'wallets' : 'symbols', need.handle)
      if (!record) return false
      if (!(await this.access.allowed(need.action, need.record, { who, proofs: keys }, { ledger: ledgerRecord, record }))) return false
    }
    return true
  }

  // Resolution checks each claim's wallets before its symbol (source, then target):
  // with both unknown the reference reports the wallet.
  private async resolve(tx: Store, ledger: string, intent: StoredRecord, earlier?: Entry[]): Promise<{ entries: Entry[]; limits: LimitOp[] }> {
    const entries: Entry[] = []
    const limits: LimitOp[] = []
    const claims: any[] = intent.data.claims
    for (const [i, c] of claims.entries()) {
      const sides = c.action === 'limit' ? ([['Wallet', c.wallet]] as const) : ([['Source', c.source], ['Target', c.target]] as const)
      const bridgeOf: Record<string, string | undefined> = {}
      for (const [side, ref] of sides) {
        if (!ref) continue
        const wallet = await tx.get(ledger, 'wallets', ref.handle)
        bridgeOf[ref.handle] = wallet?.data.bridge
        if (!wallet)
          throw new Rejection(
            'core.routing-failed',
            `${side} wallet not resolved for the address ${ref.handle} - does not resolve to any existing wallet. Parent wallet: ${ref.handle}`,
          )
      }
      const symbol = c.symbol.handle
      if (!(await tx.get(ledger, 'symbols', symbol))) throw new Rejection('core.symbol-invalid', `Symbol ${symbol} not found.`)

      if (c.action === 'limit') {
        limits.push({ wallet: c.wallet.handle, symbol, metric: c.metric, amount: c.amount })
        continue
      }
      if (earlier) continue
      const withBridge = (w: string) => (bridgeOf[w] ? { bridge: bridgeOf[w] } : {})
      if (c.source) entries.push({ schema: 'debit', handle: `deb_${entryId()}`, wallet: c.source.handle, symbol, amount: c.amount, input: i, ...withBridge(c.source.handle) })
      if (c.target) entries.push({ schema: 'credit', handle: `cre_${entryId()}`, wallet: c.target.handle, symbol, amount: c.amount, input: i, ...withBridge(c.target.handle) })
    }
    return { entries: earlier ?? entries, limits }
  }

  // A limit row is signed by the ledger like any record, and keeps its luid when a
  // later limit claim replaces its amount.
  private async limitRow(tx: Store, ledger: string, l: LimitOp, system: KeyPair, moment: string): Promise<LimitRow> {
    const existing = (await tx.limits(ledger, l.wallet)).find((r) => r.data.symbol === l.symbol && r.data.metric === l.metric)
    const data = { wallet: l.wallet, symbol: l.symbol, metric: l.metric, amount: l.amount }
    const hash = hashData(data)
    return { hash, data, luid: existing?.luid ?? newLuid('$wbl'), meta: { proofs: [serverProof(hash, { moment }, system, 'system')], moment } }
  }

  // Limits per wallet × symbol: `minBalance` (default 0) against the intent's debits,
  // `maxBalance` (default none) against its credits. Credits never offset debits and
  // debits never offset credits — the reference rejects an intent that issues 100 to
  // alice and moves the same 100 on, although the docs say it would pass.
  //
  // The reference checks `maxBalance` only after commit, and an intent that breaks it
  // stays `committed` forever with the credit unapplied. We check it here and reject;
  // that divergence is deliberate and listed in conformance/divergences.json.
  private async checkLimits(tx: Store, ledger: string, books: Books, entries: Entry[]) {
    const limit = async (wallet: string, symbol: string, metric: string) =>
      (await tx.limits(ledger, wallet)).find((r) => r.data.symbol === symbol && r.data.metric === metric)?.data.amount

    for (const schema of ['debit', 'credit'] as const) {
      const moved = new Map<string, number>()
      for (const e of entries.filter((e) => e.schema === schema)) {
        const key = `${e.wallet}\u0000${e.symbol}`
        const total = (moved.get(key) ?? 0) + e.amount
        moved.set(key, total)
        const available = await books.amount(e.wallet, e.symbol, 'available')
        const where = `for wallet ${e.wallet}, symbol ${e.symbol}, schema available`
        if (schema === 'debit') {
          const min = (await limit(e.wallet, e.symbol, 'minBalance')) ?? 0
          const after = available - total
          if (after < min) throw new Rejection('core.limit-exceeded', `Amount ${after} is less than minimum allowed amount ${min} ${where}`)
        } else {
          const max = await limit(e.wallet, e.symbol, 'maxBalance')
          const after = available + total
          if (max !== undefined && after > max)
            throw new Rejection('core.limit-exceeded', `Amount ${after} is greater than maximum allowed amount ${max} ${where}`)
        }
      }
    }
  }
}

type Stage = { proofs: number; status: string; routed: boolean }

// failed {reason, detail} → aborted → rejected, each a change of its own. The statuses
// of those changes are not recorded yet; the proof's status is used.
function reject(trail: Proof[], stage: (s: string) => void, sign: (c: Record<string, unknown>) => Proof, now: () => string, reason: string, detail: string) {
  trail.push(sign({ detail, moment: now(), reason, status: 'failed' }))
  stage('failed')
  trail.push(sign({ moment: now(), status: 'aborted' }))
  stage('aborted')
  trail.push(sign({ moment: now(), status: 'rejected' }))
  stage('rejected')
}

// Appends the trail to the intent and records one change per stage: the intent as it
// was after that stage, dated with the stage's last proof (records2: seven changes
// for an issue, `routed` appearing on its own change after `prepared`).
async function save(tx: Store, ledger: string, intent: StoredRecord, trail: Proof[], stages: Stage[]) {
  const { routed: _r, ...before } = intent.meta
  const earlier = intent.meta.proofs as Proof[]
  let n = (await tx.changes(ledger, 'intents', intent.data.handle)).length
  for (const st of stages) {
    const proofs = [...earlier, ...trail.slice(0, st.proofs)]
    const moment = proofs.at(-1)?.custom?.moment ?? intent.meta.moment
    const meta = { ...before, proofs, status: st.status, ...(st.routed ? { routed: true } : {}), moment, change: ++n, action: 'update', labels: null }
    await tx.addChange(ledger, 'intents', intent.data.handle, { ...intent, meta })
  }
  intent.meta.proofs.push(...trail)
  await tx.update(ledger, 'intents', intent)
}

// Entries a bridge takes part in: those of transfers whose wallet has a bridge. An
// issue or destroy records the bridge but does not call it (resolution-proofs;
// recorded: an issue to a bridged wallet completed without a call).
function bridgedEntries(claims: any[], entries: Entry[]) {
  return entries.filter((e) => e.bridge && claims[e.input]?.action === 'transfer')
}

// The `$ben` luid an entry is sent with; derived, so a retry after a restart repeats it.
const LUID_ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'
function entryLuid(ledger: string, handle: string) {
  const bytes = createHash('sha256').update(`${ledger}\u0000${handle}`).digest()
  let id = '-'
  for (let i = 0; i < 16; i++) id += LUID_ALPHABET[bytes[i] & 63]
  return `$ben.${id}`
}

/** One pass over an intent inside a transaction: what it adds, and how to save it. */
class Run {
  readonly now = clock()
  readonly trail: Proof[] = []
  readonly stages: Stage[] = []
  readonly books: Books
  readonly limitWrites: LimitRow[] = []
  readonly sign = (custom: Record<string, unknown>) => serverProof(this.intent.hash, custom, this.system, 'system')
  readonly stage = (status: string, routed = false) => void this.stages.push({ proofs: this.trail.length, status, routed })

  constructor(
    readonly tx: Store,
    readonly ledger: string,
    readonly intent: StoredRecord,
    readonly system: KeyPair,
    readonly core: KeyPair,
  ) {
    this.books = new Books(tx, ledger)
  }

  private get proofs(): Proof[] {
    return [...this.intent.meta.proofs, ...this.trail]
  }

  corePrepared() {
    return this.proofs.some((p) => p.signer === 'core' && p.custom?.status === 'prepared')
  }

  /** Has a participant other than the ledger reported one of these statuses for an entry? */
  reported(entry: string, statuses: string[]) {
    return this.proofs.some((p) => p.custom?.handle === entry && !SERVER_SIGNERS.has(p.signer ?? '') && p.origin && statuses.includes(p.custom.status as string))
  }

  /** The intent as bridges see it now: without `domains` (recorded). */
  snapshot(status: string, routed = false) {
    const { domains: _d, routed: _r, proofs: _p, status: _s, ...meta } = this.intent.meta
    return { hash: this.intent.hash, data: this.intent.data, luid: this.intent.luid, meta: { proofs: this.proofs, status, ...meta, ...(routed ? { routed: true } : {}) } }
  }

  // Nothing is written until the pass is over, so a rejection leaves no trace in the
  // books and the memory store needs no rollback.
  async finish() {
    for (const row of this.books.changed()) await this.tx.putBalance(this.ledger, row)
    for (const row of this.limitWrites) await this.tx.putLimit(this.ledger, row)
    await save(this.tx, this.ledger, this.intent, this.trail, this.stages)
  }
}

/** Permissions the claims need (about-authorization, access actions). */
function needsOf(claims: any[]): Need[] {
  const needs: Need[] = []
  for (const c of claims) {
    if (c.action === 'issue') needs.push({ action: 'issue', record: 'symbol', handle: c.symbol.handle })
    if (c.action === 'destroy') needs.push({ action: 'destroy', record: 'symbol', handle: c.symbol.handle })
    if (c.source) needs.push({ action: 'spend', record: 'wallet', handle: c.source.handle })
    if (c.action === 'limit') needs.push({ action: 'limit', record: 'wallet', handle: c.wallet.handle })
  }
  return needs
}

const SERVER_SIGNERS = new Set(['system', 'core'])

// The keys an intent is signed with, as access rules see them. A proof `system.auth`
// made on a token's behalf counts as the impersonated signer's key, and its `bearer.*`
// claims stand in for the token, which is gone by the time the intent is processed.
async function signersOf(tx: Store, ledger: string, intent: StoredRecord): Promise<{ keys: string[]; who?: Principal }> {
  const keys: string[] = []
  let who: Principal | undefined
  for (const p of intent.meta.proofs as Proof[]) {
    if (p.signer && SERVER_SIGNERS.has(p.signer) && p.origin === 'key-pair') continue
    if (!p.origin) continue // bare core clearance proofs
    if (p.origin === 'self-signed-token' && p.signer) {
      const signer = await tx.get(ledger, 'signers', p.signer)
      if (!signer) continue
      keys.push(signer.data.public)
      const claims = Object.fromEntries(Object.entries(p.custom ?? {}).filter(([k]) => k.startsWith('bearer.')).map(([k, v]) => [k.slice(7), v]))
      who = { public: signer.data.public, claims }
      continue
    }
    keys.push(p.public)
  }
  return { keys: [...new Set(keys)], who }
}

/** Entries of an intent resolved earlier, rebuilt from its `resolved` proofs. */
function resolvedEntries(intent: StoredRecord): Entry[] | undefined {
  const resolved = (intent.meta.proofs as Proof[]).filter((p) => p.signer === 'system' && p.custom?.status === 'resolved')
  if (!resolved.length) return undefined
  return resolved.map(({ custom: c }: any) => ({ schema: c.schema, handle: c.handle, wallet: c.wallet, symbol: c.symbol, amount: c.amount, input: c.inputs[0], ...(c.bridge ? { bridge: c.bridge } : {}) }))
}

/** When the client created the intent: the moment of its `created` proof. */
function createdMoment(intent: StoredRecord): number | undefined {
  const p = (intent.meta.proofs as Proof[]).find((p) => p.custom?.status === 'created' && p.signer !== 'system')
  const m = p?.custom?.moment
  return typeof m === 'string' ? Date.parse(m) : undefined
}

/** Balance rows touched by one intent, read once and written back at the end. */
class Books {
  private rows = new Map<string, BalanceRow>()
  private loaded = new Set<string>()
  private dirty = new Set<string>()

  constructor(
    private readonly tx: Store,
    private readonly ledger: string,
  ) {}

  private async load(wallet: string) {
    if (this.loaded.has(wallet)) return
    for (const r of await this.tx.balances(this.ledger, wallet)) this.rows.set(`${wallet}\u0000${r.data.symbol}\u0000${r.data.schema}`, r)
    this.loaded.add(wallet)
  }

  async amount(wallet: string, symbol: string, schema: 'available' | 'reserved') {
    await this.load(wallet)
    return this.rows.get(`${wallet}\u0000${symbol}\u0000${schema}`)?.data.amount ?? 0
  }

  // A row touched by a reservation carries `parent: ""` from then on — the
  // reference's serialisation, reproduced because clients see it.
  async move(wallet: string, symbol: string, schema: 'available' | 'reserved', delta: number, moment: string, reservation: boolean) {
    await this.load(wallet)
    const key = `${wallet}\u0000${symbol}\u0000${schema}`
    let row = this.rows.get(key)
    if (!row) {
      row = { hash: '', data: { wallet, symbol, schema, amount: 0 }, luid: newLuid('$wbl'), meta: { moment } }
      this.rows.set(key, row)
    }
    if (reservation && row.data.parent === undefined) row.data = { parent: '', ...row.data }
    row.data.amount += delta
    row.meta.moment = moment
    this.dirty.add(key)
  }

  // Setting a limit re-saves an existing available row the way a reservation does
  // (`parent: ""`, new moment) without changing its amount. Observed on the reference:
  // the row's moment equals the limit's. A wallet without a row gets none.
  async touch(wallet: string, symbol: string, moment: string) {
    await this.load(wallet)
    const key = `${wallet}\u0000${symbol}\u0000available`
    const row = this.rows.get(key)
    if (!row) return
    if (row.data.parent === undefined) row.data = { parent: '', ...row.data }
    row.meta.moment = moment
    this.dirty.add(key)
  }

  /** Changed rows, new ones in the order they were created. */
  changed() {
    return [...this.dirty].map((k) => this.rows.get(k)!)
  }
}
