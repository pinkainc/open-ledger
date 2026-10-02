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
import { Bridges, type BridgeCall, type BridgeOptions, type Outcome } from './bridges.js'
import { createHash } from 'node:crypto'
import { RoutingError, filterMatches, resolveAddress, route } from './routing.js'
import { SecretBox, resolveRefs, secretRefs } from './secrets.js'
import { matches, parseQuery } from './query.js'

const entryId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 17)
// Event handles: `evt_` and 17 characters, `-` and `_` among them (recorded).
const eventId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_', 17)

type LimitOp = { wallet: string; symbol: string; metric: string; amount: number }

type Entry = { schema: 'debit' | 'credit'; handle: string; wallet: string; symbol: string; amount: number; input: number; bridge?: string }

/**
 * One bridge's share of an intent, which the bridge prepares, commits or aborts as a
 * unit: an entry, or several entries grouped by the bridge's `debits|credits.claims.groupBy`
 * (recorded, l6). A group of one keeps the entry's handle; a larger group gets a handle
 * of its own.
 */
type Part = { handle: string; schema: 'debit' | 'credit'; bridge: string; entries: Entry[] }

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
  /** Seals the secrets records refer to; one per server (secrets.ts). */
  secrets?: SecretBox
}

/** A claim permission: an action on one wallet or symbol. */
type Need = { action: string; record: 'wallet' | 'symbol'; handle: string }

export class Core {
  /** Access rules for claim permissions; set by the app that owns the rules. */
  access?: AccessControl
  readonly bridges: Bridges
  readonly secrets: SecretBox
  private readonly minuteMs: number
  private expiryTimer?: NodeJS.Timeout

  constructor(
    private readonly store: Store,
    { minuteMs = 60_000, bridges, secrets = new SecretBox() }: CoreOptions = {},
  ) {
    this.minuteMs = minuteMs
    this.secrets = secrets
    this.bridges = new Bridges(bridges)
    this.bridges.onAttempt = (call, outcome) => this.recordAttempt(call, outcome)
    this.bridges.authorize = (call) => this.authorize(call)
    this.bridges.onStart = (call) => this.markRunning(call)
  }

  // ---- bridge authentication (about-bridges, "Bridge authentication"; recorded, secure) --

  // The headers a bridge's `secure` rules give, in their order, a later rule winning a
  // header an earlier one set. `header` sets its key to the resolved secret; `oauth2`
  // asks the token endpoint — with Basic `clientId:clientSecret` and a form body
  // `grant_type=client_credentials[&scope=…]` — and sets `Authorization: Bearer`.
  // Recorded: the reference asks for a token before every call, `expires_in` or not;
  // so do we (a cache is an optimisation the docs promise but the reference lacks).
  private async authorize(call: BridgeCall): Promise<Record<string, string>> {
    const ledger = call.ledger
    const bridge = ledger ? await this.store.get(ledger, 'bridges', call.bridge) : undefined
    const rules: any[] = bridge?.data.secure ?? []
    if (!ledger || !rules.length) return {}
    const values = new Map<string, string>()
    for (const name of secretRefs(rules)) {
      const at = `bridge/${call.bridge}/${name}`
      const sealed = await this.store.getSecret(ledger, at)
      if (sealed === undefined) throw new Error(`secret ${name} of bridge ${call.bridge} is missing`)
      values.set(name, this.secrets.open(sealed, `${ledger}/${at}`))
    }
    const headers: Record<string, string> = {}
    for (const rule of resolveRefs(rules, (n) => values.get(n)!)) {
      if (rule.schema === 'header') headers[rule.key] = rule.value
      if (rule.schema === 'oauth2') headers.Authorization = `Bearer ${await oauthToken(rule)}`
    }
    return headers
  }

  /** Process an intent after the current request has been answered. */
  schedule(ledger: string, handle: string) {
    setImmediate(() => void this.process(ledger, handle).catch((e) => console.error(`intent ${ledger}/${handle}:`, e)))
  }

  /**
   * Pick up what a previous run left unfinished: intents are moved on from their trail,
   * and deliveries not yet accepted (pending or failed) are sent again, their output
   * unchanged. Bridges treat a repeat as a no-op.
   */
  async resume() {
    for (const l of await this.store.list('', 'ledgers')) {
      const ledger = l.data.handle
      for (const i of await this.store.list(ledger, 'intents')) if (!FINAL.has(i.meta.status)) this.schedule(ledger, i.data.handle)
      for (const d of await this.store.list(ledger, 'events'))
        if (d.meta.status === 'pending' || d.meta.status === 'failed') {
          const call = await this.callOf(ledger, d)
          if (call) void this.bridges.deliver(call)
        }
    }
  }

  // ---- deliveries (inspect-event-deliveries) ----------------------------------------

  // Each call becomes a delivery record `$evd`, written in the transaction of the step
  // that caused it, so a call is never lost between the trail and the wire.
  private async enqueue(tx: Store, ledger: string, call: BridgeCall, linked: string, of?: { bridge: string | null; effect: string; record: string | null; linked: string | null; output: unknown }) {
    const handle = entryId()
    const data = of
      ? { handle, bridge: of.bridge, effect: of.effect, record: of.record, linked: of.linked }
      : { handle, bridge: call.bridge, effect: null, record: 'intent', linked }
    const record: StoredRecord = {
      hash: hashData(data),
      data,
      luid: newLuid('$evd'),
      meta: { status: 'pending', replay: 0, moment: new Date().toISOString(), output: of ? of.output : call.body, proofs: [] },
    }
    await tx.insert(ledger, 'events', record)
    call.ledger = ledger
    call.delivery = handle
  }

  // ---- effects (register-effect, handle-webhooks; recorded, effects) ----------------

  /**
   * Raises an event. Each effect on the signal whose `filter` the event matches gets a
   * delivery, written in the caller's transaction; the caller sends the returned calls
   * once it has committed. One event — one `evt_` handle — for all of them, and none
   * at all when no effect is listening.
   *
   * The event is the ledger's record `{handle, signal, …payload}` signed by `system`;
   * `about` names the record the deliveries are linked to (`data.record`, `data.linked`).
   */
  async raise(tx: Store, ledger: string, signal: string, payload: Record<string, unknown>, about: { record: string; linked: string }): Promise<BridgeCall[]> {
    const effects = (await tx.list(ledger, 'effects')).filter((e) => e.data.signal === signal)
    if (!effects.length) return []
    const data = { handle: `evt_${eventId()}`, signal, ...payload }
    const listening = effects.filter((e) => !e.data.filter || matches(data, parseQuery(flatFilter(e.data.filter))))
    if (!listening.length) return []
    const key = (await tx.getKey(ledger, 'system'))!
    const hash = hashData(data)
    const event = { hash, data, meta: { proofs: [serverProof(hash, { moment: new Date().toISOString() }, key, 'system')] } }
    const calls: BridgeCall[] = []
    for (const effect of listening) {
      const call = await this.effectCall(tx, ledger, effect, event)
      if (!call) continue
      // An effect whose bridge is missing still gets a delivery, but one that knows
      // nothing of the event: no record, no link, no output (recorded).
      const lost = call.unreachable !== undefined
      await this.enqueue(tx, ledger, call, about.linked, {
        bridge: effect.data.action?.schema === 'bridge' ? effect.data.action.bridge : null,
        effect: effect.data.handle,
        record: lost ? null : about.record,
        linked: lost ? null : about.linked,
        output: lost ? null : event,
      })
      calls.push(call)
    }
    return calls
  }

  // Where an effect's event goes: a webhook's endpoint, or `POST {server}/effects/{effect}`
  // of its bridge. A bridge with traits takes effects only with the trait `effects` (the
  // docs say `events`, which the reference refuses); without traits, everything.
  private async effectCall(tx: Store, ledger: string, effect: StoredRecord, event: unknown): Promise<BridgeCall | undefined> {
    const action = effect.data.action ?? {}
    const of = { method: 'POST' as const, body: event, effect: effect.data.handle as string }
    if (action.schema === 'webhook') return { ...of, bridge: '', server: action.endpoint, path: '' }
    const bridge = await tx.get(ledger, 'bridges', action.bridge)
    if (!bridge) return { ...of, bridge: action.bridge, server: '', path: '', unreachable: `Bridge ${action.bridge} not found` }
    if (!hasTrait(bridge.data, 'effects', (event as any)?.data)) return undefined
    return { ...of, bridge: action.bridge, server: bridge.data.config?.server, path: `/effects/${encodeURIComponent(effect.data.handle)}` }
  }

  /** Raises an event outside a transaction of the caller's and sends its calls. */
  async announce(ledger: string, signal: string, payload: Record<string, unknown>, about: { record: string; linked: string }) {
    if (!(await this.store.list(ledger, 'effects')).some((e) => e.data.signal === signal)) return
    const calls = await this.store.transaction(ledger, (tx) => this.raise(tx, ledger, signal, payload, about))
    for (const c of calls) void this.bridges.deliver(c)
  }

  // A delivery being attempted is `running` (recorded, secure: a delivery caught in
  // flight, no proofs, replay 0); the attempt's outcome then replaces the status.
  private async markRunning(call: BridgeCall) {
    if (!call.ledger || !call.delivery) return
    const ledger = call.ledger
    await this.store.transaction(ledger, async (tx) => {
      const d = await tx.get(ledger, 'events', call.delivery!)
      if (!d || d.meta.status === 'running') return
      d.meta.status = 'running'
      await tx.update(ledger, 'events', d)
    })
  }

  /** Each attempt is signed into its delivery; `replay` counts the attempts. */
  private async recordAttempt(call: BridgeCall, outcome: Outcome) {
    if (!call.ledger || !call.delivery) return
    const ledger = call.ledger
    await this.store.transaction(ledger, async (tx) => {
      const d = await tx.get(ledger, 'events', call.delivery!)
      const key = await tx.getKey(ledger, 'system')
      if (!d || !key) return
      const moment = new Date().toISOString()
      const { status, ...rest } = outcome
      d.meta.proofs.push(serverProof(d.hash, { ...rest, moment, status }, key, 'system'))
      // A call with nowhere to go counts its cancellation as an attempt too (recorded).
      if (status !== 'cancelled' || call.unreachable) d.meta.replay = (d.meta.replay ?? 0) + 1
      d.meta.status = status
      d.meta.moment = new Date(Date.parse(moment) + 1).toISOString()
      await tx.update(ledger, 'events', d)
      if (status === 'cancelled' && d.data.record === 'intent' && !d.data.effect) await this.noteUnreachable(tx, ledger, d, key)
    })
  }

  // A delivery the ledger gave up on is noted on its intent (recorded, events): a
  // `system` proof with status `error` that changes nothing else — the intent keeps
  // waiting, and a retry of the delivery can still complete it.
  private async noteUnreachable(tx: Store, ledger: string, d: StoredRecord, key: KeyPair) {
    const intent = await tx.get(ledger, 'intents', d.data.linked)
    if (!intent || FINAL.has(intent.meta.status)) return
    const httpStatus = [...d.meta.proofs].reverse().find((p: Proof) => p.custom?.status === 'failed')?.custom?.detail?.httpStatus
    const detail = httpStatus ? `Request failed with status code ${httpStatus}` : 'Bridge unreachable'
    const moment = new Date().toISOString()
    intent.meta.proofs.push(serverProof(intent.hash, { detail, moment, reason: 'core.bridge-unreachable', status: 'error' }, key, 'system'))
    const n = (await tx.changes(ledger, 'intents', intent.data.handle)).length
    const { routed: _r, ...meta } = intent.meta
    await tx.addChange(ledger, 'intents', intent.data.handle, { ...intent, meta: { ...meta, moment, change: n + 1, action: 'update', labels: null } })
    await tx.update(ledger, 'intents', intent)
  }

  // A delivery's call, rebuilt from its output: a prepared entry (`schema`), a command
  // (`action`) or the intent itself (a status notification).
  private async callOf(ledger: string, d: StoredRecord): Promise<BridgeCall | undefined> {
    if (d.data.effect) {
      const effect = await this.store.get(ledger, 'effects', d.data.effect)
      if (!effect) return undefined
      const call = await this.effectCall(this.store, ledger, effect, d.meta.output)
      return call && { ...call, ledger, delivery: d.data.handle }
    }
    const server = await this.server(this.store, ledger, d.data.bridge)
    if (!server) return undefined
    const out: any = d.meta.output
    const x = out?.data ?? {}
    const call = (method: 'POST' | 'PUT', path: string): BridgeCall => ({ bridge: d.data.bridge, server, method, path, body: out, ledger, delivery: d.data.handle })
    if (x.action) return call('POST', `/${String(x.handle).startsWith('deb_') ? 'debits' : 'credits'}/${x.handle}/${x.action}`)
    if (x.schema === 'debit' || x.schema === 'credit') return call('POST', `/${x.schema}s`)
    return call('PUT', `/intents/${encodeURIComponent(x.handle)}`)
  }

  /**
   * Sends deliveries of a bridge or an effect again (retry endpoint): one by handle, whatever its
   * status; or every failed, cancelled or pending one whose last attempt is at most
   * `maxAge` minutes old (0: any age). Returns false for an unknown handle.
   */
  async retryDeliveries(ledger: string, owner: 'bridge' | 'effect', handle: string, by: { handle?: string; maxAge?: number }) {
    const all = (await this.store.list(ledger, 'events')).filter((d) => d.data[owner] === handle)
    let chosen: StoredRecord[]
    if (by.handle !== undefined) {
      chosen = all.filter((d) => d.data.handle === by.handle)
      if (!chosen.length) return false
    } else {
      const minutes = Math.min(by.maxAge ?? 60, 48 * 60)
      const since = Date.now() - minutes * 60_000
      chosen = all.filter((d) => ['failed', 'cancelled', 'pending'].includes(d.meta.status) && (minutes === 0 || Date.parse(d.meta.moment) >= since))
    }
    for (const d of chosen) {
      await this.store.transaction(ledger, async (tx) => {
        const fresh = await tx.get(ledger, 'events', d.data.handle)
        if (!fresh) return
        fresh.meta.status = 'pending'
        await tx.update(ledger, 'events', fresh)
      })
      const call = await this.callOf(ledger, d)
      if (call) void this.bridges.deliver(call)
    }
    return true
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
  async process(ledger: string, handle: string) {
    const calls: Delivery[] = []
    let wake: string[] = []
    await this.store.transaction(ledger, async (tx) => {
      const intent = await tx.get(ledger, 'intents', handle)
      if (!intent || FINAL.has(intent.meta.status)) return
      const run = new Run(tx, ledger, intent, (await tx.getKey(ledger, 'system'))!, (await tx.getKey(ledger, 'core'))!)
      const threaded = await isThreaded(tx, ledger, intent)
      try {
        const failure = threaded && ['pending', 'prepared'].includes(intent.meta.status) ? await threadFailure(tx, ledger, intent) : undefined
        if (failure) await this.abort(run, calls, await this.partsToAbort(run), failure.reason, failure.detail)
        else if (intent.meta.status === 'pending') await this.advancePending(run, calls)
        else if (intent.meta.status === 'prepared') await this.advancePrepared(run, calls)
        else if (intent.meta.status === 'committed') await this.advanceCommitted(run, calls)
        else if (intent.meta.status === 'aborted') await this.advanceAborted(run, calls)
      } catch (e) {
        if (!(e instanceof Rejection)) throw e
        reject(run.trail, run.stage, run.sign, run.now, e.reason, e.detail)
        intent.meta.status = 'rejected'
      }
      for (const d of calls) for (const c of d.calls) await this.enqueue(tx, ledger, c, handle)
      const raised = await this.intentEvents(run)
      if (raised.length) calls.push({ order: 'parallel', calls: raised })
      await run.finish()
      wake = [...run.spawned, ...(threaded && run.trail.length ? await wakeable(tx, ledger, intent) : [])]
    })
    await this.deliver(calls)
    for (const h of new Set(wake)) this.schedule(ledger, h)
  }

  // Events of one pass (recorded, effects): `intent-updated` for each saved version
  // that moved the intent on, carrying the version before as `parent`, and
  // `balance-received` for each credit once the intent commits. The reference skips
  // the version that only resolves entries, and the version cleared by the core's own
  // proofs is never a parent: completion names the commit before it (a race of its
  // stages, reproduced). Versions here leave out `domains`, as there.
  private async intentEvents(run: Run): Promise<BridgeCall[]> {
    const { tx, ledger, intent } = run
    // Called before the pass is saved: the stored proofs are those before it.
    const version = (st: Stage) => {
      const { domains: _d, routed: _r, proofs, status: _s, ...meta } = intent.meta
      return { hash: intent.hash, data: intent.data, luid: intent.luid, meta: { ...meta, proofs: [...proofs, ...run.trail.slice(0, st.proofs)], status: st.status, ...(st.routed ? { routed: true } : {}) } }
    }
    const about = { record: 'intent', linked: intent.data.handle }
    const calls: BridgeCall[] = []
    const versions = [run.start, ...run.stages]
    const cleared = (i: number) => i > 0 && versions[i].status === 'committed' && versions[i - 1].status === 'committed'
    for (let i = 1; i < versions.length; i++) {
      const st = versions[i], prev = versions[i - 1]
      if (st.status === 'pending' || (st.status === prev.status && st.proofs === prev.proofs)) continue
      let j = i - 1
      while (j > 0 && cleared(j)) j--
      calls.push(...(await this.raise(tx, ledger, 'intent-updated', { intent: version(st), parent: version(versions[j]) }, about)))
    }
    for (const r of run.received) {
      const at = run.stages.find((st) => st.proofs === r.proofs && st.status === 'committed')!
      const [wallet, symbol] = [await tx.get(ledger, 'wallets', r.wallet), await tx.get(ledger, 'symbols', r.symbol)]
      calls.push(...(await this.raise(tx, ledger, 'balance-received', { amount: r.amount, intent: version(at), symbol, wallet }, { record: 'wallet', linked: r.wallet })))
    }
    return calls
  }

  // Parts to tell to abort: those asked to prepare, once the prepare phase has begun.
  private async partsToAbort(run: Run) {
    return (await run.prepareStarted()) ? sentParts(run, await partsOf(run, resolvedEntries(run.intent) ?? [])) : []
  }

  // pending: resolve, check permissions and limits, prepare. With bridged entries the
  // intent then waits for every bridge to report `prepared` (or one to report `failed`).
  private async advancePending(run: Run, calls: Delivery[]) {
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

    const parts = await partsOf(run, entries)
    const debitParts = parts.filter((p) => p.schema === 'debit')
    const creditParts = parts.filter((p) => p.schema === 'credit')
    const debits = entries.filter((e) => e.schema === 'debit')
    if (!(await run.prepareStarted(true))) {
      // Bridges get the intent as it was resolved, before the core's own prepare.
      const resolved = run.snapshot('pending')
      await this.checkLimits(tx, ledger, run.books, entries, !intent.data.origin)
      // The ledger core takes part as a participant only when balances are spent — and
      // not in an intent a forward route made (recorded: no core proofs, no reservation).
      if (debits.length && !intent.data.origin) {
        const tp = run.now()
        for (const e of entries) trail.push(serverProof(intent.hash, { handle: e.handle, moment: tp, schema: e.schema, status: 'prepared' }, run.core, 'core'))
        for (const e of debits) {
          await run.books.move(e.wallet, e.symbol, 'available', -e.amount, tp, true)
          await run.books.move(e.wallet, e.symbol, 'reserved', +e.amount, tp, true)
        }
      }
      // Prepare runs in two phases (recorded, l6): debits first; credits only once every
      // debit has been prepared. Without bridged debits, credits go out at once.
      if (parts.length) {
        run.stage('pending')
        if (!debitParts.length) await run.tx.once(ledger, creditsKey(intent))
        calls.push({ order: 'parallel', calls: await this.entryCalls(run, debitParts.length ? debitParts : creditParts, resolved) })
        return
      }
    }

    if (parts.length) {
      const failed = parts.filter((p) => run.reported(p.handle, ['failed']))
      if (failed.length) {
        const names = [...new Set(failed.map((p) => p.bridge))].join(', ')
        return this.abort(run, calls, sentParts(run, parts), 'core.bridge-prepare-failed', `Bridge(s) failed to process intent: ${names}`)
      }
      if (!debitParts.every((p) => run.reported(p.handle, ['prepared']))) return
      // Credits carry the intent as it is now, with the debits' reports (recorded).
      // Two reports can arrive together; the mark keeps the credits from going twice.
      if (creditParts.length && (await run.tx.once(ledger, creditsKey(intent)))) {
        calls.push({ order: 'parallel', calls: await this.entryCalls(run, creditParts, run.snapshot('pending', false, true)) })
        return
      }
      if (!creditParts.every((p) => run.reported(p.handle, ['prepared']))) return
    }
    await this.commit(run, calls, entries, limits, parts)
  }

  // prepared → committed: the ledger commits its own part at once; bridges are told to
  // commit and the intent completes when each has reported `committed`.
  //
  // A thread commits as one (about-intents, "Intent threads"; recorded, l7): an intent
  // that forwarded waits `prepared` until every intent of its thread is prepared, the
  // first intent commits first and each forward intent after the one that made it.
  private async commit(run: Run, calls: Delivery[], entries: Entry[], limits: LimitOp[], bridged: Part[]) {
    const { intent, trail } = run
    trail.push(run.sign({ moment: run.now(), status: 'prepared' }))
    run.stage('prepared')
    if (!(await this.forward(run, entries))) return this.abort(run, calls, bridged, 'core.thread-size-exceeded', `Thread size exceeded the maximum of ${MAX_THREAD}`)
    if (bridged.length) calls.push({ order: 'parallel', calls: await this.statusCalls(run, bridged, run.snapshot('prepared')) })
    if (!(await threadReady(run))) {
      // Waiting, routed (recorded; on the reference `routed` is a stage of its own that
      // raced a forward intent refused at once — one recording has it, one has not).
      intent.meta.status = 'prepared'
      intent.meta.routed = true
      run.stage('prepared', true)
      return
    }
    await this.commitPrepared(run, calls, entries, limits, bridged)
  }

  // Waiting for the thread: commit once it is ready.
  private async advancePrepared(run: Run, calls: Delivery[]) {
    if (!(await threadReady(run))) return
    const { entries, limits } = await this.resolve(run.tx, run.ledger, run.intent, resolvedEntries(run.intent))
    await this.commitPrepared(run, calls, entries, limits, await partsOf(run, entries))
  }

  private async commitPrepared(run: Run, calls: Delivery[], entries: Entry[], limits: LimitOp[], bridged: Part[]) {
    const { tx, ledger, intent, trail } = run
    if (!intent.meta.routed) run.stage('prepared', true)
    trail.push(run.sign({ detail: 'awaiting-clearance', moment: run.now(), status: 'committed' }))
    run.stage('committed', true)
    for (const e of entries.filter((e) => e.schema === 'credit')) run.received.push({ wallet: e.wallet, symbol: e.symbol, amount: e.amount, proofs: trail.length })
    if (bridged.length) calls.push({ order: 'parallel', calls: await this.commandCalls(run, bridged, 'commit', run.snapshot('committed', true)) })

    const tc = run.now()
    for (const l of limits) {
      run.limitWrites.push(await this.limitRow(tx, ledger, l, run.system, tc))
      await run.books.touch(l.wallet, l.symbol, tc)
    }
    const debits = entries.filter((e) => e.schema === 'debit')
    const reserved = debits.length > 0 && !intent.data.origin
    for (const e of debits)
      if (reserved) await run.books.move(e.wallet, e.symbol, 'reserved', -e.amount, tc, true)
      else await run.books.move(e.wallet, e.symbol, 'available', -e.amount, tc, false)
    for (const e of entries.filter((e) => e.schema === 'credit')) await run.books.move(e.wallet, e.symbol, 'available', +e.amount, tc, false)
    if (reserved) {
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

  // A credit that ended at a `forward` route is passed on in a new intent of the same
  // thread, made and signed by the ledger once the first is prepared (recorded):
  // `{handle: <17 characters>, claims: [transfer wallet → route target], origin}`.
  //
  // A thread holds at most MAX_THREAD intents (release notes v2.3.0). The reference
  // checks that only once the whole thread is prepared, so a forward loop runs away
  // first (recorded, l7: thousands of intents); we refuse the intent that would make
  // the thread too large. Returns false then.
  private async forward(run: Run, entries: Entry[]) {
    const { tx, ledger, intent } = run
    const claims: any[] = intent.data.claims
    const forwards: { e: Entry; target: string }[] = []
    for (const e of entries.filter((e) => e.schema === 'credit')) {
      const c = claims[e.input]
      const wallet = await tx.get(ledger, 'wallets', e.wallet)
      const r = ((wallet?.data.routes ?? []) as any[]).filter((r) => ['credit', 'forward', 'accept'].includes(r.action)).find((r) => filterMatches(r.filter, c, intent))
      if (r?.action === 'forward') forwards.push({ e, target: r.target })
    }
    if (!forwards.length) return true
    if ((await threadOf(tx, ledger, intent)).length + forwards.length > MAX_THREAD) return false
    await tx.once(ledger, threadKey(intent))
    for (const { e, target } of forwards) {
      const data = {
        handle: entryId(),
        claims: [{ action: 'transfer', amount: e.amount, source: { handle: e.wallet }, symbol: { handle: e.symbol }, target: { handle: target } }],
        origin: intent.data.handle,
      }
      const hash = hashData(data)
      const luid = newLuid('$int')
      const moment = run.now()
      const { signer: _s, origin: _o, ...created } = serverProof(hash, { moment, status: 'created' }, run.system, 'system')
      const proofs = [created as Proof, serverProof(hash, { moment: run.now(), status: 'pending' }, run.system, 'system'), serverProof(hash, { luid, moment: run.now(), status: 'pending' }, run.system, 'system')]
      const record: StoredRecord = { hash, data, luid, meta: { proofs, status: 'pending', thread: intent.meta.thread, domains: [], moment, owners: [run.system.public] } }
      await tx.insert(ledger, 'intents', record)
      await tx.addChange(ledger, 'intents', data.handle, { ...record, meta: { ...record.meta, change: 1, action: 'create', labels: null } })
      run.spawned.push(data.handle)
    }
    return true
  }

  private async advanceCommitted(run: Run, calls: Delivery[]) {
    const bridged = await partsOf(run, resolvedEntries(run.intent) ?? [])
    if (bridged.every((e) => run.reported(e.handle, ['committed']))) await this.complete(run, calls, bridged)
  }

  private async complete(run: Run, calls: Delivery[], bridged: Part[]) {
    run.trail.push(run.sign({ moment: run.now(), status: 'completed' }))
    run.stage('completed', true)
    run.intent.meta.status = 'completed'
    if (bridged.length) calls.push({ order: 'parallel', calls: await this.statusCalls(run, bridged, run.snapshot('completed', true)) })
  }

  // failed → aborted: every part that was asked to prepare is told to abort (the
  // failing one too; a credit whose prepare never went out is not), and the intent is
  // rejected once each has reported `aborted`; then the core releases its reservations.
  private async abort(run: Run, calls: Delivery[], bridged: Part[], reason: string, detail: string) {
    run.trail.push(run.sign({ detail, moment: run.now(), reason, status: 'failed' }))
    run.stage('failed')
    run.trail.push(run.sign({ moment: run.now(), status: 'aborted' }))
    run.stage('aborted')
    run.intent.meta.status = 'aborted'
    if (bridged.length) calls.push({ order: 'parallel', calls: await this.commandCalls(run, bridged, 'abort', run.snapshot('aborted')) })
    else await this.rejectAborted(run, calls, bridged)
  }

  private async advanceAborted(run: Run, calls: Delivery[]) {
    const bridged = sentParts(run, await partsOf(run, resolvedEntries(run.intent) ?? []))
    if (bridged.every((e) => run.reported(e.handle, ['aborted']))) await this.rejectAborted(run, calls, bridged)
  }

  private async rejectAborted(run: Run, calls: Delivery[], bridged: Part[]) {
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

  // Prepare: the part as a signed record. Observed: both `source` and `target` of the
  // claim, the claim index as `inputs`, and a `$ben` luid that stays the same when the
  // call is retried. A group sums its entries, lists every claim in `inputs` and sends
  // `null` for the side it does not group (l6).
  private async entryCalls(run: Run, parts: Part[], intent: unknown): Promise<BridgeCall[]> {
    const out: BridgeCall[] = []
    const claims: any[] = run.intent.data.claims
    for (const p of parts) {
      const server = await this.server(run.tx, run.ledger, p.bridge)
      if (!server) continue
      const c = claims[p.entries[0].input]
      const sides =
        p.entries.length === 1
          ? { ...(c.source ? { source: c.source } : {}), ...(c.target ? { target: c.target } : {}) }
          : p.schema === 'debit'
            ? { source: c.source, target: null }
            : { source: null, target: c.target }
      const data = {
        handle: p.handle,
        luid: entryLuid(run.ledger, p.handle),
        schema: p.schema,
        ...sides,
        symbol: c.symbol,
        amount: p.entries.reduce((n, e) => n + e.amount, 0),
        inputs: p.entries.map((e) => e.input),
        intent,
      }
      out.push({ bridge: p.bridge, server, method: 'POST', path: `/${p.schema}s`, body: this.signed(run, data) })
    }
    return out
  }

  private async commandCalls(run: Run, entries: Part[], action: 'commit' | 'abort', intent: unknown): Promise<BridgeCall[]> {
    const out: BridgeCall[] = []
    for (const e of entries) {
      const server = await this.server(run.tx, run.ledger, e.bridge)
      if (server) out.push({ bridge: e.bridge, server, method: 'POST', path: `/${e.schema}s/${e.handle}/${action}`, body: this.signed(run, { handle: e.handle, action, intent }) })
    }
    return out
  }

  // Status notifications go once to each bridge of the intent that was asked to prepare:
  // on `prepared` and on the final status (recorded; a rejected intent that never
  // prepared gets only the last, and a bridge whose credit never went out, none — l6).
  // A bridge whose traits leave out `statuses` gets none (recorded, secure).
  private async statusCalls(run: Run, parts: Part[], intent: any): Promise<BridgeCall[]> {
    const out: BridgeCall[] = []
    for (const bridge of new Set(parts.map((p) => p.bridge))) {
      const record = await run.tx.get(run.ledger, 'bridges', bridge)
      if (!hasTrait(record?.data ?? {}, 'statuses', run.intent.data)) continue
      const server = record?.data.config?.server as string | undefined
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
  //
  // The docs say the whole thread is aborted. The reference never expired a forward
  // intent waiting for its bridge (recorded, l7: still pending after nine minutes, its
  // thread stuck); we expire it, and the rest of the thread follows with its reason.
  private async expireOne(ledger: string, handle: string) {
    const calls: Delivery[] = []
    let wake: string[] = []
    await this.store.transaction(ledger, async (tx) => {
      const intent = await tx.get(ledger, 'intents', handle)
      if (!intent || intent.meta.status !== 'pending') return
      const run = new Run(tx, ledger, intent, (await tx.getKey(ledger, 'system'))!, (await tx.getKey(ledger, 'core'))!)
      await this.abort(run, calls, await this.partsToAbort(run), 'core.intent-expired', `Intent ${intent.data.handle} expired`)
      for (const d of calls) for (const c of d.calls) await this.enqueue(tx, ledger, c, handle)
      const raised = await this.intentEvents(run)
      if (raised.length) calls.push({ order: 'parallel', calls: raised })
      await run.finish()
      if (await isThreaded(tx, ledger, intent)) wake = await wakeable(tx, ledger, intent)
    })
    await this.deliver(calls)
    for (const h of wake) this.schedule(ledger, h)
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

  // Every claim needs its permission from at least one of the intent's signers. A
  // wallet named by address is the wallet the address resolves to. An intent the
  // ledger made itself (a forward route's, `data.origin`) was authorised by its origin.
  private async permitted(tx: Store, ledger: string, intent: StoredRecord) {
    if (!this.access || intent.data.origin) return true
    const ledgerRecord = await tx.get('', 'ledgers', ledger)
    if (!ledgerRecord) return false
    const { keys, who } = await signersOf(tx, ledger, intent)
    for (const need of needsOf(intent.data.claims)) {
      const record = need.record === 'wallet' ? await resolveAddress(tx, ledger, need.handle) : await tx.get(ledger, 'symbols', need.handle)
      if (!record) return false
      if (!(await this.access.allowed(need.action, need.record, { who, proofs: keys }, { ledger: ledgerRecord, record }))) return false
    }
    return true
  }

  // Resolution checks each claim's wallets before its symbol (source, then target):
  // with both unknown the reference reports the wallet. An address resolves up its
  // hierarchy and then along the wallet's routes (routing.ts); the entry names the
  // wallet it ended at, and that wallet's bridge. Routes are followed once, on the
  // first pass; later passes rebuild the entries from the resolved proofs.
  private async resolve(tx: Store, ledger: string, intent: StoredRecord, earlier?: Entry[]): Promise<{ entries: Entry[]; limits: LimitOp[] }> {
    const entries: Entry[] = []
    const limits: LimitOp[] = []
    const claims: any[] = intent.data.claims
    const unresolved = (side: string, address: string) =>
      new Rejection('core.routing-failed', `${side} wallet not resolved for the address ${address} - does not resolve to any existing wallet. Parent wallet: ${address}`)
    for (const [i, c] of claims.entries()) {
      const ends: Partial<Record<'Source' | 'Target', StoredRecord>> = {}
      if (c.action === 'limit') {
        if (!(await tx.get(ledger, 'wallets', c.wallet.handle))) throw unresolved('Wallet', c.wallet.handle)
      } else if (!earlier) {
        for (const side of ['Source', 'Target'] as const) {
          if (!(side === 'Source' ? c.source : c.target)) continue
          try {
            const routed = await route(tx, ledger, intent, c, side)
            if (!routed) throw unresolved(side, (side === 'Source' ? c.source : c.target).handle)
            ends[side] = routed.wallet
          } catch (e) {
            if (e instanceof RoutingError) throw new Rejection('core.routing-failed', e.detail)
            throw e
          }
        }
      }
      const symbol = c.symbol.handle
      if (!(await tx.get(ledger, 'symbols', symbol))) throw new Rejection('core.symbol-invalid', `Symbol ${symbol} not found.`)

      if (c.action === 'limit') {
        limits.push({ wallet: c.wallet.handle, symbol, metric: c.metric, amount: c.amount })
        continue
      }
      if (earlier) continue
      const entry = (schema: 'debit' | 'credit', w: StoredRecord): Entry => ({
        schema,
        handle: `${schema === 'debit' ? 'deb' : 'cre'}_${entryId()}`,
        wallet: w.data.handle,
        symbol,
        amount: c.amount,
        input: i,
        ...(w.data.bridge ? { bridge: w.data.bridge } : {}),
      })
      if (ends.Source) entries.push(entry('debit', ends.Source))
      if (ends.Target) entries.push(entry('credit', ends.Target))
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
  //
  // A forward intent's debit is not checked: it spends a credit of its thread that is
  // prepared but not yet committed (recorded, l7: the forward intent prepares while the
  // wallet is still empty), and the thread commits as one.
  private async checkLimits(tx: Store, ledger: string, books: Books, entries: Entry[], debits = true) {
    const limit = async (wallet: string, symbol: string, metric: string) =>
      (await tx.limits(ledger, wallet)).find((r) => r.data.symbol === symbol && r.data.metric === metric)?.data.amount

    for (const schema of ['debit', 'credit'] as const) {
      const moved = new Map<string, number>()
      for (const e of entries.filter((e) => e.schema === schema && (debits || schema === 'credit'))) {
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

// Parts per bridge, in the order of their first entry. Grouping keys (about-bridges):
// `address` — the claim's source (debits) or target (credits) as written; `wallet` —
// the resolved wallet. A symbol is never summed with another.
async function partsOf(run: Run, entries: Entry[]): Promise<Part[]> {
  const claims: any[] = run.intent.data.claims
  const bridges = new Map<string, Record<string, any>>()
  const groups = new Map<string, Entry[]>()
  for (const e of bridgedEntries(claims, entries)) {
    if (!bridges.has(e.bridge!)) bridges.set(e.bridge!, (await run.tx.get(run.ledger, 'bridges', e.bridge!))?.data ?? {})
    const bridge = bridges.get(e.bridge!)!
    const c = claims[e.input]
    // A bridge takes part only in what its traits let through (filtered on the entry).
    const entry = { schema: e.schema, ...(c.source ? { source: c.source } : {}), ...(c.target ? { target: c.target } : {}), symbol: c.symbol, amount: e.amount, inputs: [e.input], intent: run.intent }
    if (!hasTrait(bridge, `${e.schema}s`, entry)) continue
    const by = (bridge.config ?? {})[`${e.schema}s.claims.groupBy`]
    const address = (e.schema === 'debit' ? c.source : c.target)?.handle
    const key = by === 'address' ? `address ${address}` : by === 'wallet' ? `wallet ${e.wallet}` : `entry ${e.handle}`
    const k = [e.bridge, e.schema, e.symbol, key].join('\u0000')
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  return [...groups].map(([k, es]) => ({
    handle: es.length === 1 ? es[0].handle : groupHandle(run.ledger, run.intent.data.handle, k, es[0].schema),
    schema: es[0].schema,
    bridge: es[0].bridge!,
    entries: es,
  }))
}

// Traits (about-bridges): a bridge without `traits` takes part in everything; with
// them, only in the methods listed — a string, or `{method, filter}` whose filter is a
// query on the call's data (dot paths, operators).
function hasTrait(bridge: Record<string, any>, method: string, data: unknown) {
  const traits: any[] | undefined = bridge.traits
  if (!traits) return true
  const t = traits.find((t) => t === method || t?.method === method)
  if (!t) return false
  return typeof t === 'string' || !t.filter || matches(data as object, parseQuery(flatFilter(t.filter)))
}

// `{amount: {$gte: 100}}` → `{'amount.$gte': 100}`, the form query.ts parses.
function flatFilter(filter: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [path, cond] of Object.entries(filter)) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).every((k) => k.startsWith('$')))
      for (const [op, v] of Object.entries(cond)) out[`${path}.${op}`] = v
    else out[path] = cond
  }
  return out
}

async function oauthToken(rule: { clientId: string; clientSecret: string; tokenUrl: string; scope?: string }) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', ...(rule.scope ? { scope: rule.scope } : {}) })
  const res = await fetch(rule.tokenUrl, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${rule.clientId}:${rule.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  const json: any = await res.json().catch(() => undefined)
  if (!res.ok || typeof json?.access_token !== 'string') throw new Error(`OAuth2 token request to ${rule.tokenUrl} failed with status ${res.status}`)
  return json.access_token as string
}

// Parts that were asked to prepare: every debit, and the credits once all debits were
// prepared (or at once, without bridged debits).
function sentParts(run: Run, parts: Part[]) {
  const debits = parts.filter((p) => p.schema === 'debit')
  const creditsSent = debits.every((p) => run.reported(p.handle, ['prepared']))
  return parts.filter((p) => p.schema === 'debit' || creditsSent)
}

const creditsKey = (intent: StoredRecord) => `intent ${intent.luid} credits prepared`

// ---- threads ----------------------------------------------------------------------

export const MAX_THREAD = 10

/** Marks a thread that has more than one intent; most never do and skip the lookups. */
const threadKey = (intent: StoredRecord) => `thread ${intent.meta.thread} forwarded`

async function isThreaded(tx: Store, ledger: string, intent: StoredRecord) {
  return !!intent.data.origin || (await tx.marked(ledger, threadKey(intent)))
}

// Intents of one thread. A scan of the ledger's intents: threads are rare and short
// (MAX_THREAD); an index by thread is the obvious next step if that ever matters.
async function threadOf(tx: Store, ledger: string, intent: StoredRecord) {
  return (await tx.list(ledger, 'intents')).filter((i) => i.meta.thread === intent.meta.thread)
}

const preparedBySystem = (i: StoredRecord) => (i.meta.proofs as Proof[]).some((p) => p.signer === 'system' && p.custom?.status === 'prepared')
const failureOf = (i: StoredRecord) => (i.meta.proofs as Proof[]).find((p) => p.signer === 'system' && p.custom?.status === 'failed')?.custom

// When one intent of a thread fails, the others fail with its reason and detail
// (recorded, l7: the first intent of a thread whose forward intent was refused).
async function threadFailure(tx: Store, ledger: string, intent: StoredRecord): Promise<{ reason: string; detail: string } | undefined> {
  if (failureOf(intent)) return undefined
  for (const i of await threadOf(tx, ledger, intent)) {
    const f = i.data.handle !== intent.data.handle && failureOf(i)
    if (f) return { reason: String(f.reason), detail: String(f.detail) }
  }
  return undefined
}

// The first intent commits once every intent of the thread is prepared; a forward
// intent, once the intent that made it has committed.
async function threadReady(run: Run) {
  const { tx, ledger, intent } = run
  if (!(await isThreaded(tx, ledger, intent))) return true
  if (intent.data.origin) {
    const origin = await tx.get(ledger, 'intents', intent.data.origin)
    return !!origin && ['committed', 'completed'].includes(origin.meta.status)
  }
  return (await threadOf(tx, ledger, intent)).every((i) => i.data.handle === intent.data.handle || preparedBySystem(i))
}

/** Other unfinished intents of the thread, which a change to this one may move on. */
async function wakeable(tx: Store, ledger: string, intent: StoredRecord) {
  return (await threadOf(tx, ledger, intent)).filter((i) => i.data.handle !== intent.data.handle && !FINAL.has(i.meta.status)).map((i) => i.data.handle)
}

// A group's handle, derived so that every pass (and a restart) names it the same.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
function groupHandle(ledger: string, intent: string, key: string, schema: 'debit' | 'credit') {
  const bytes = createHash('sha256').update(`${ledger}\u0000${intent}\u0000${key}`).digest()
  let id = ''
  for (let i = 0; i < 17; i++) id += BASE62[bytes[i] % 62]
  return `${schema === 'debit' ? 'deb' : 'cre'}_${id}`
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
  /** Intents this pass made (forward routes), to be processed after it. */
  readonly spawned: string[] = []
  readonly sign = (custom: Record<string, unknown>) => serverProof(this.intent.hash, custom, this.system, 'system')
  readonly stage = (status: string, routed = false) => void this.stages.push({ proofs: this.trail.length, status, routed })
  /** Balances this pass credited, for `balance-received`, with the trail length at the time. */
  readonly received: { wallet: string; symbol: string; amount: number; proofs: number }[] = []
  /** The intent as it was before this pass: its last saved version. */
  readonly start: Stage

  constructor(
    readonly tx: Store,
    readonly ledger: string,
    readonly intent: StoredRecord,
    readonly system: KeyPair,
    readonly core: KeyPair,
  ) {
    this.books = new Books(tx, ledger)
    this.start = { proofs: 0, status: intent.meta.status, routed: !!intent.meta.routed }
  }

  private get proofs(): Proof[] {
    return [...this.intent.meta.proofs, ...this.trail]
  }

  corePrepared() {
    return this.proofs.some((p) => p.signer === 'core' && p.custom?.status === 'prepared')
  }

  /**
   * Has the prepare phase begun? The core's own `prepared` proofs say so — except in an
   * intent a forward route made, which has none (recorded), so a mark stands in for
   * them. `start` sets the mark: the caller is about to begin.
   */
  async prepareStarted(start = false) {
    if (!this.intent.data.origin) return this.corePrepared()
    const key = `intent ${this.intent.luid} prepare`
    return start ? !(await this.tx.once(this.ledger, key)) : this.tx.marked(this.ledger, key)
  }

  /** Has a participant other than the ledger reported one of these statuses for an entry? */
  reported(entry: string, statuses: string[]) {
    return this.proofs.some((p) => p.custom?.handle === entry && !SERVER_SIGNERS.has(p.signer ?? '') && p.origin && statuses.includes(p.custom.status as string))
  }

  /**
   * The intent as bridges see it now: without `domains` (recorded) — except in the
   * second prepare phase, whose credits carry `domains: []` after the other fields (l6).
   */
  snapshot(status: string, routed = false, domains = false) {
    const { domains: d, routed: _r, proofs: _p, status: _s, ...meta } = this.intent.meta
    return {
      hash: this.intent.hash,
      data: this.intent.data,
      luid: this.intent.luid,
      meta: { proofs: this.proofs, status, ...meta, ...(routed ? { routed: true } : {}), ...(domains ? { domains: d ?? [] } : {}) },
    }
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
  /** Rows this pass created; moving one again in the same pass is not an update. */
  private created = new Set<string>()

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

  // A row that is updated — an earlier row moved again, or any row a reservation
  // touches — carries `parent: ""` from then on; a row only ever created by one credit
  // has none. The reference's serialisation, reproduced because clients see it
  // (every balance in every recording fits this rule).
  async move(wallet: string, symbol: string, schema: 'available' | 'reserved', delta: number, moment: string, reservation: boolean) {
    await this.load(wallet)
    const key = `${wallet}\u0000${symbol}\u0000${schema}`
    let row = this.rows.get(key)
    const existed = !!row && !this.created.has(key)
    if (!row) {
      row = { hash: '', data: { wallet, symbol, schema, amount: 0 }, luid: newLuid('$wbl'), meta: { moment } }
      this.rows.set(key, row)
      this.created.add(key)
    }
    if ((reservation || existed) && row.data.parent === undefined) row.data = { parent: '', ...row.data }
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
