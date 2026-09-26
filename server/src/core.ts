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
import type { BalanceRow, Store, StoredRecord } from './store.js'

const entryId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 17)

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

      try {
        const entries = await this.resolve(tx, ledger, intent)
        const t = now()
        for (const e of entries)
          trail.push(
            sign({ amount: e.amount, handle: e.handle, inputs: [e.input], moment: t, schema: e.schema, status: 'resolved', symbol: e.symbol, wallet: e.wallet }),
          )

        const books = new Books(tx, ledger)
        await this.checkLimits(books, entries)

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
      intent.meta.proofs.push(...trail)
      await tx.update(ledger, 'intents', intent)
    })
  }

  private async resolve(tx: Store, ledger: string, intent: StoredRecord): Promise<Entry[]> {
    const entries: Entry[] = []
    const claims: any[] = intent.data.claims
    for (const [i, c] of claims.entries()) {
      const symbol = c.symbol.handle
      if (!(await tx.get(ledger, 'symbols', symbol))) throw new Rejection('core.symbol-invalid', `Symbol ${symbol} not found.`)
      for (const [side, ref] of [['Source', c.source], ['Target', c.target]] as const) {
        if (!ref) continue
        if (!(await tx.get(ledger, 'wallets', ref.handle)))
          throw new Rejection(
            'core.routing-failed',
            `${side} wallet not resolved for the address ${ref.handle} - does not resolve to any existing wallet. Parent wallet: ${ref.handle}`,
          )
      }
      if (c.source) entries.push({ schema: 'debit', handle: `deb_${entryId()}`, wallet: c.source.handle, symbol, amount: c.amount, input: i })
      if (c.target) entries.push({ schema: 'credit', handle: `cre_${entryId()}`, wallet: c.target.handle, symbol, amount: c.amount, input: i })
    }
    return entries
  }

  // Available balance may not fall below zero. Credits of the same intent are not
  // counted towards it: the reference reports bob at 2000 − 999999 in a two-claim
  // intent that also credits bob 100.
  private async checkLimits(books: Books, entries: Entry[]) {
    const spent = new Map<string, number>()
    for (const e of entries.filter((e) => e.schema === 'debit')) {
      const key = `${e.wallet}\u0000${e.symbol}`
      const total = (spent.get(key) ?? 0) + e.amount
      spent.set(key, total)
      const after = (await books.amount(e.wallet, e.symbol, 'available')) - total
      if (after < 0)
        throw new Rejection(
          'core.limit-exceeded',
          `Amount ${after} is less than minimum allowed amount 0 for wallet ${e.wallet}, symbol ${e.symbol}, schema available`,
        )
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

  /** Changed rows, new ones in the order they were created. */
  changed() {
    return [...this.dirty].map((k) => this.rows.get(k)!)
  }
}
