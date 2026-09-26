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

const entryId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 17)

type LimitOp = { wallet: string; symbol: string; metric: string; amount: number }

type Entry = { schema: 'debit' | 'credit'; handle: string; wallet: string; symbol: string; amount: number; input: number }

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
}

/** A claim permission: an action on one wallet or symbol. */
type Need = { action: string; record: 'wallet' | 'symbol'; handle: string }

export class Core {
  /** Access rules for claim permissions; set by the app that owns the rules. */
  access?: AccessControl
  private readonly minuteMs: number
  private expiryTimer?: NodeJS.Timeout

  constructor(
    private readonly store: Store,
    { minuteMs = 60_000 }: CoreOptions = {},
  ) {
    this.minuteMs = minuteMs
  }

  /** Process an intent after the current request has been answered. */
  schedule(ledger: string, handle: string) {
    setImmediate(() => void this.process(ledger, handle).catch((e) => console.error(`intent ${ledger}/${handle}:`, e)))
  }

  /** Pick up intents left pending by a previous run. */
  async resume() {
    for (const l of await this.store.list('', 'ledgers'))
      for (const i of await this.store.list(l.data.handle, 'intents'))
        if (i.meta.status === 'pending') this.schedule(l.data.handle, i.data.handle)
  }

  async process(ledger: string, handle: string) {
    await this.store.transaction(ledger, async (tx) => {
      const intent = await tx.get(ledger, 'intents', handle)
      if (!intent || intent.meta.status !== 'pending') return // already processed

      const system = (await tx.getKey(ledger, 'system'))!
      const core = (await tx.getKey(ledger, 'core'))!
      const now = clock()
      const sign = (custom: Record<string, unknown>) => serverProof(intent.hash, custom, system, 'system')
      const trail: Proof[] = []
      // Each stage the reference saves separately is one change of the intent.
      const stages: Stage[] = []
      const stage = (status: string, routed = false) => stages.push({ proofs: trail.length, status, routed })
      const writes: BalanceRow[] = []
      const limitWrites: LimitRow[] = []

      try {
        // An intent that waited for signatures was resolved before; its entries are
        // in its trail and are not resolved twice.
        const earlier = resolvedEntries(intent)
        const { entries, limits } = await this.resolve(tx, ledger, intent, earlier)
        if (!earlier) {
          const t = now()
          for (const e of entries)
            trail.push(
              sign({ amount: e.amount, handle: e.handle, inputs: [e.input], moment: t, schema: e.schema, status: 'resolved', symbol: e.symbol, wallet: e.wallet }),
            )
        }
        if (trail.length) stage('pending')
        if (!(await this.permitted(tx, ledger, intent))) {
          // Waiting: nothing moves, no reservation is taken.
          await save(tx, ledger, intent, trail, stages)
          return
        }

        const books = new Books(tx, ledger)
        await this.checkLimits(tx, ledger, books, entries)

        const debits = entries.filter((e) => e.schema === 'debit')
        // The ledger core takes part as a participant only when balances are spent.
        if (debits.length) {
          const tp = now()
          for (const e of entries) trail.push(serverProof(intent.hash, { handle: e.handle, moment: tp, schema: e.schema, status: 'prepared' }, core, 'core'))
          for (const e of debits) {
            await books.move(e.wallet, e.symbol, 'available', -e.amount, tp, true)
            await books.move(e.wallet, e.symbol, 'reserved', +e.amount, tp, true)
          }
        }
        trail.push(sign({ moment: now(), status: 'prepared' }))
        stage('prepared')
        stage('prepared', true)
        trail.push(sign({ detail: 'awaiting-clearance', moment: now(), status: 'committed' }))
        stage('committed', true)

        const tc = now()
        for (const l of limits) {
          limitWrites.push(await this.limitRow(tx, ledger, l, system, tc))
          await books.touch(l.wallet, l.symbol, tc)
        }
        for (const e of debits) await books.move(e.wallet, e.symbol, 'reserved', -e.amount, tc, true)
        for (const e of entries.filter((e) => e.schema === 'credit')) await books.move(e.wallet, e.symbol, 'available', +e.amount, tc, false)
        if (debits.length) {
          for (const e of entries) {
            // Clearance proofs by the core are bare: no `signer`, no `origin`.
            const { signer: _s, origin: _o, ...bare } = serverProof(intent.hash, { detail: 'cleared', handle: e.handle, moment: tc, schema: e.schema, status: 'committed' }, core, 'core')
            trail.push(bare as Proof)
          }
        } else {
          trail.push(sign({ coreId: intent.data.handle, detail: 'cleared', moment: tc, status: 'committed' }))
        }
        stage('committed', true)
        trail.push(sign({ moment: now(), status: 'completed' }))
        stage('completed', true)
        writes.push(...books.changed())
        intent.meta.status = 'completed'
        intent.meta.routed = true
      } catch (e) {
        if (!(e instanceof Rejection)) throw e
        reject(trail, stage, sign, now, e.reason, e.detail)
        intent.meta.status = 'rejected'
      }

      // Nothing is written until the outcome is known, so a rejection leaves no trace
      // in the books and the memory store needs no rollback.
      for (const row of writes) await tx.putBalance(ledger, row)
      for (const row of limitWrites) await tx.putLimit(ledger, row)
      await save(tx, ledger, intent, trail, stages)
    })
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
        await this.store.transaction(l.data.handle, async (tx) => {
          const intent = await tx.get(l.data.handle, 'intents', i.data.handle)
          if (!intent || intent.meta.status !== 'pending') return
          const system = (await tx.getKey(l.data.handle, 'system'))!
          const now = clock()
          const sign = (custom: Record<string, unknown>) => serverProof(intent.hash, custom, system, 'system')
          const trail: Proof[] = []
          const stages: Stage[] = []
          const stage = (status: string) => stages.push({ proofs: trail.length, status, routed: false })
          reject(trail, stage, sign, now, 'core.intent-expired', `Intent ${intent.data.handle} expired`)
          intent.meta.status = 'rejected'
          await save(tx, l.data.handle, intent, trail, stages)
        })
      }
    }
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
      for (const [side, ref] of sides) {
        if (!ref) continue
        if (!(await tx.get(ledger, 'wallets', ref.handle)))
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
      if (c.source) entries.push({ schema: 'debit', handle: `deb_${entryId()}`, wallet: c.source.handle, symbol, amount: c.amount, input: i })
      if (c.target) entries.push({ schema: 'credit', handle: `cre_${entryId()}`, wallet: c.target.handle, symbol, amount: c.amount, input: i })
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
  return resolved.map(({ custom: c }: any) => ({ schema: c.schema, handle: c.handle, wallet: c.wallet, symbol: c.symbol, amount: c.amount, input: c.inputs[0] }))
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
