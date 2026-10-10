// Storage boundary. Two implementations: memory (tests, quick runs) and Postgres.
//
// Money-moving work runs inside `transaction(ledger, fn)`, which serialises all
// transactions of one ledger: a mutex in memory, an advisory transaction lock in
// Postgres. That is deliberately coarse — correctness first; per-wallet locking is an
// optimisation tracked in TODO.md.
import type { KeyPair } from './crypto.js'

export type StoredRecord = {
  hash: string
  data: Record<string, any>
  luid: string
  meta: Record<string, any>
}

/** One balance row as the reference serves it: per wallet × symbol × schema. */
export type BalanceRow = {
  hash: string
  data: { parent?: string; wallet: string; symbol: string; schema: 'available' | 'reserved'; amount: number }
  luid: string
  meta: { moment: string }
}

/** A wallet limit as the reference serves it: signed, luid prefix `$wbl` like balances. */
export type LimitRow = {
  hash: string
  data: { wallet: string; symbol: string; metric: string; amount: number }
  luid: string
  meta: { proofs: unknown[]; moment: string }
}

export interface Store {
  get(ledger: string, kind: string, handle: string): Promise<StoredRecord | undefined>
  getByLuid(ledger: string, kind: string, luid: string): Promise<StoredRecord | undefined>
  /** Returns false when a record with this handle already exists. */
  insert(ledger: string, kind: string, record: StoredRecord): Promise<boolean>
  /** Replaces the stored record with the same handle. */
  update(ledger: string, kind: string, record: StoredRecord): Promise<void>
  /** Removes a record; its change history stays. */
  remove(ledger: string, kind: string, handle: string): Promise<void>
  /** Appends a snapshot to a record's change history (numbered by the caller). */
  addChange(ledger: string, kind: string, handle: string, change: StoredRecord): Promise<void>
  /** Change history, oldest first. */
  changes(ledger: string, kind: string, handle: string): Promise<StoredRecord[]>
  /** Oldest first. */
  list(ledger: string, kind: string): Promise<StoredRecord[]>
  /** The ledger's own server signers (`system`, `core`). Never served. */
  getKey(ledger: string, signer?: string): Promise<KeyPair | undefined>
  putKey(ledger: string, key: KeyPair, signer?: string): Promise<void>
  /** Balance rows of one wallet, in creation order. */
  balances(ledger: string, wallet: string): Promise<BalanceRow[]>
  putBalance(ledger: string, row: BalanceRow): Promise<void>
  /** Limit rows of one wallet, in creation order. */
  limits(ledger: string, wallet: string): Promise<LimitRow[]>
  /** Inserts, or replaces the row for the same wallet × symbol × metric. */
  putLimit(ledger: string, row: LimitRow): Promise<void>
  /**
   * Marks a step as taken: true the first time a key is seen in a ledger, false after.
   * For the few decisions a proof trail cannot record without changing what clients
   * read, e.g. that the credit prepares of an intent went out (core.ts).
   */
  once(ledger: string, key: string): Promise<boolean>
  /** Whether `once` has seen a key. */
  marked(ledger: string, key: string): Promise<boolean>
  /** Sealed secrets (secrets.ts), by a name such as `bridge/<handle>/<secret>`. */
  getSecret(ledger: string, name: string): Promise<string | undefined>
  putSecret(ledger: string, name: string, sealed: string): Promise<void>
  transaction<T>(ledger: string, fn: (tx: Store) => Promise<T>): Promise<T>
  /** Forgets a ledger: its record (server scope) and everything kept under it, history included. */
  dropLedger(ledger: string): Promise<void>
}

const clone = <T>(v: T): T => structuredClone(v)

/** A record's key within its kind: its handle, or its luid for records without one (circle signers). */
export const keyOf = (r: StoredRecord): string => r.data.handle ?? r.luid

export class MemoryStore implements Store {
  private rows = new Map<string, StoredRecord[]>()
  private keys = new Map<string, KeyPair>()
  private bals = new Map<string, BalanceRow[]>()
  private lims = new Map<string, LimitRow[]>()
  private hist = new Map<string, StoredRecord[]>()
  private locks = new Map<string, Promise<unknown>>()
  private marks = new Set<string>()
  private secrets = new Map<string, string>()

  private bucket<T>(map: Map<string, T[]>, key: string) {
    let b = map.get(key)
    if (!b) map.set(key, (b = []))
    return b
  }
  private records = (ledger: string, kind: string) => this.bucket(this.rows, `${ledger}\u0000${kind}`)

  async get(ledger: string, kind: string, handle: string) {
    const r = this.records(ledger, kind).find((r) => keyOf(r) === handle)
    return r && clone(r)
  }

  async getByLuid(ledger: string, kind: string, luid: string) {
    const r = this.records(ledger, kind).find((r) => r.luid === luid)
    return r && clone(r)
  }

  async insert(ledger: string, kind: string, record: StoredRecord) {
    const b = this.records(ledger, kind)
    if (b.some((r) => keyOf(r) === keyOf(record))) return false
    b.push(clone(record))
    return true
  }

  async update(ledger: string, kind: string, record: StoredRecord) {
    const b = this.records(ledger, kind)
    const i = b.findIndex((r) => keyOf(r) === keyOf(record))
    if (i < 0) throw new Error(`update of missing ${kind} ${keyOf(record)}`)
    b[i] = clone(record)
  }

  async list(ledger: string, kind: string) {
    return clone(this.records(ledger, kind))
  }

  async remove(ledger: string, kind: string, handle: string) {
    const b = this.records(ledger, kind)
    const i = b.findIndex((r) => keyOf(r) === handle)
    if (i >= 0) b.splice(i, 1)
  }

  async addChange(ledger: string, kind: string, handle: string, change: StoredRecord) {
    this.bucket(this.hist, `${ledger}\u0000${kind}\u0000${handle}`).push(clone(change))
  }

  async changes(ledger: string, kind: string, handle: string) {
    return clone(this.bucket(this.hist, `${ledger}\u0000${kind}\u0000${handle}`))
  }

  async getKey(ledger: string, signer = 'system') {
    return this.keys.get(`${ledger}\u0000${signer}`)
  }

  async putKey(ledger: string, key: KeyPair, signer = 'system') {
    this.keys.set(`${ledger}\u0000${signer}`, key)
  }

  async balances(ledger: string, wallet: string) {
    return clone(this.bucket(this.bals, ledger).filter((r) => r.data.wallet === wallet))
  }

  async putBalance(ledger: string, row: BalanceRow) {
    const b = this.bucket(this.bals, ledger)
    const i = b.findIndex((r) => r.luid === row.luid)
    if (i < 0) b.push(clone(row))
    else b[i] = clone(row)
  }

  async limits(ledger: string, wallet: string) {
    return clone(this.bucket(this.lims, ledger).filter((r) => r.data.wallet === wallet))
  }

  async putLimit(ledger: string, row: LimitRow) {
    const b = this.bucket(this.lims, ledger)
    const same = (r: LimitRow) => r.data.wallet === row.data.wallet && r.data.symbol === row.data.symbol && r.data.metric === row.data.metric
    const i = b.findIndex(same)
    if (i < 0) b.push(clone(row))
    else b[i] = clone(row)
  }

  async once(ledger: string, key: string) {
    const k = `${ledger}\u0000${key}`
    if (this.marks.has(k)) return false
    this.marks.add(k)
    return true
  }

  async getSecret(ledger: string, name: string) {
    return this.secrets.get(`${ledger}\u0000${name}`)
  }

  async putSecret(ledger: string, name: string, sealed: string) {
    this.secrets.set(`${ledger}\u0000${name}`, sealed)
  }

  async marked(ledger: string, key: string) {
    return this.marks.has(`${ledger}\u0000${key}`)
  }

  async dropLedger(ledger: string) {
    const inside = (k: string) => k.startsWith(`${ledger}\u0000`)
    for (const map of [this.rows, this.keys, this.bals, this.lims, this.hist, this.secrets] as Map<string, unknown>[])
      for (const k of [...map.keys()]) if (inside(k) || k === ledger) map.delete(k)
    for (const k of [...this.marks]) if (inside(k)) this.marks.delete(k)
    await this.remove('', 'ledgers', ledger)
    // Changes of the ledger record itself live at the server scope.
    this.hist.delete(`\u0000ledgers\u0000${ledger}`)
  }

  // Chains every transaction of a ledger behind the previous one. The callback gets
  // this same store: in memory there is nothing to roll back, because a transaction
  // either runs to completion or throws before writing (see core.ts).
  async transaction<T>(ledger: string, fn: (tx: Store) => Promise<T>): Promise<T> {
    const prev = this.locks.get(ledger) ?? Promise.resolve()
    const run: Promise<T> = prev.then(() => fn(this))
    this.locks.set(ledger, run.catch(() => undefined))
    return run
  }
}
