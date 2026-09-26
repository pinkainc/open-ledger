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
  transaction<T>(ledger: string, fn: (tx: Store) => Promise<T>): Promise<T>
}

const clone = <T>(v: T): T => structuredClone(v)

export class MemoryStore implements Store {
  private rows = new Map<string, StoredRecord[]>()
  private keys = new Map<string, KeyPair>()
  private bals = new Map<string, BalanceRow[]>()
  private lims = new Map<string, LimitRow[]>()
  private locks = new Map<string, Promise<unknown>>()

  private bucket<T>(map: Map<string, T[]>, key: string) {
    let b = map.get(key)
    if (!b) map.set(key, (b = []))
    return b
  }
  private records = (ledger: string, kind: string) => this.bucket(this.rows, `${ledger}\u0000${kind}`)

  async get(ledger: string, kind: string, handle: string) {
    const r = this.records(ledger, kind).find((r) => r.data.handle === handle)
    return r && clone(r)
  }

  async getByLuid(ledger: string, kind: string, luid: string) {
    const r = this.records(ledger, kind).find((r) => r.luid === luid)
    return r && clone(r)
  }

  async insert(ledger: string, kind: string, record: StoredRecord) {
    const b = this.records(ledger, kind)
    if (b.some((r) => r.data.handle === record.data.handle)) return false
    b.push(clone(record))
    return true
  }

  async update(ledger: string, kind: string, record: StoredRecord) {
    const b = this.records(ledger, kind)
    const i = b.findIndex((r) => r.data.handle === record.data.handle)
    if (i < 0) throw new Error(`update of missing ${kind} ${record.data.handle}`)
    b[i] = clone(record)
  }

  async list(ledger: string, kind: string) {
    return clone(this.records(ledger, kind))
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
