// Storage boundary. L0 ships an in-memory store; the Postgres store replaces it
// behind the same interface when balances start to move (L1), because that is the
// first level where durability and row locking decide correctness.

import type { KeyPair } from './crypto.js'

export type StoredRecord = {
  hash: string
  data: Record<string, any>
  luid: string
  meta: Record<string, any>
}

export interface Store {
  get(ledger: string, kind: string, handle: string): Promise<StoredRecord | undefined>
  /** Returns false when a record with this handle already exists. */
  insert(ledger: string, kind: string, record: StoredRecord): Promise<boolean>
  list(ledger: string, kind: string): Promise<StoredRecord[]>
  /** The ledger's own `system` signer. Kept apart from records: it is never served. */
  getKey(ledger: string): Promise<KeyPair | undefined>
  putKey(ledger: string, key: KeyPair): Promise<void>
}

export class MemoryStore implements Store {
  private rows = new Map<string, StoredRecord[]>()
  private keys = new Map<string, KeyPair>()

  private bucket(ledger: string, kind: string) {
    const key = `${ledger}\u0000${kind}`
    let b = this.rows.get(key)
    if (!b) this.rows.set(key, (b = []))
    return b
  }

  async get(ledger: string, kind: string, handle: string) {
    return this.bucket(ledger, kind).find((r) => r.data.handle === handle)
  }

  async insert(ledger: string, kind: string, record: StoredRecord) {
    const b = this.bucket(ledger, kind)
    if (b.some((r) => r.data.handle === record.data.handle)) return false
    b.push(record)
    return true
  }

  async list(ledger: string, kind: string) {
    return [...this.bucket(ledger, kind)]
  }

  async getKey(ledger: string) {
    return this.keys.get(ledger)
  }

  async putKey(ledger: string, key: KeyPair) {
    this.keys.set(ledger, key)
  }
}
