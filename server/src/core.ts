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
// How we get there is ours. The reference runs these steps as separate asynchronous
// stages with intermediate states visible to readers; here one intent is processed in
// a single transaction that serialises the ledger, so balances can never be observed
// half-moved and a crash leaves the intent `pending`, to be picked up again on start.
import { customAlphabet } from 'nanoid'
import { serverProof, type KeyPair, type Proof } from './crypto.js'
import { newLuid } from './ids.js'
import type { BalanceRow, LimitRow, Store, StoredRecord } from './store.js'
import { hashData } from './crypto.js'

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

export class Core {
  private queue = new Map<string, Promise<void>>()

  constructor(private readonly store: Store) {}

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
      const writes: BalanceRow[] = []
      const limitWrites: LimitRow[] = []

      try {
        const { entries, limits } = await this.resolve(tx, ledger, intent)
        const t = now()
        for (const e of entries)
          trail.push(
            sign({ amount: e.amount, handle: e.handle, inputs: [e.input], moment: t, schema: e.schema, status: 'resolved', symbol: e.symbol, wallet: e.wallet }),
          )

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
        trail.push(sign({ detail: 'awaiting-clearance', moment: now(), status: 'committed' }))

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
        trail.push(sign({ moment: now(), status: 'completed' }))
        writes.push(...books.changed())
        intent.meta.status = 'completed'
        intent.meta.routed = true
      } catch (e) {
        if (!(e instanceof Rejection)) throw e
        trail.push(sign({ detail: e.detail, moment: now(), reason: e.reason, status: 'failed' }))
        trail.push(sign({ moment: now(), status: 'aborted' }))
        trail.push(sign({ moment: now(), status: 'rejected' }))
        intent.meta.status = 'rejected'
      }

      // Nothing is written until the outcome is known, so a rejection leaves no trace
      // in the books and the memory store needs no rollback.
      for (const row of writes) await tx.putBalance(ledger, row)
      for (const row of limitWrites) await tx.putLimit(ledger, row)
      intent.meta.proofs.push(...trail)
      await tx.update(ledger, 'intents', intent)
    })
  }

  // Resolution checks each claim's wallets before its symbol (source, then target):
  // with both unknown the reference reports the wallet.
  private async resolve(tx: Store, ledger: string, intent: StoredRecord): Promise<{ entries: Entry[]; limits: LimitOp[] }> {
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
      if (c.source) entries.push({ schema: 'debit', handle: `deb_${entryId()}`, wallet: c.source.handle, symbol, amount: c.amount, input: i })
      if (c.target) entries.push({ schema: 'credit', handle: `cre_${entryId()}`, wallet: c.target.handle, symbol, amount: c.amount, input: i })
    }
    return { entries, limits }
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
