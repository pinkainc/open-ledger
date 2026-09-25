// Postgres store. Records keep their wire form in jsonb; the columns beside it exist
// for identity and ordering. Handles are unique per (ledger, kind), luids globally.
import pg from 'pg'
import type { KeyPair } from './crypto.js'
import type { Store, StoredRecord } from './store.js'

const SCHEMA = `
create table if not exists records (
  seq    bigserial primary key,
  ledger text  not null,
  kind   text  not null,
  handle text  not null,
  luid   text  not null unique,
  hash   text  not null,
  data   jsonb not null,
  meta   jsonb not null,
  unique (ledger, kind, handle)
);
create table if not exists ledger_keys (
  ledger text primary key,
  key    jsonb not null
);
`

export class PgStore implements Store {
  private constructor(readonly pool: pg.Pool) {}

  static async connect(url: string) {
    const pool = new pg.Pool({ connectionString: url, max: 20 })
    await pool.query(SCHEMA)
    return new PgStore(pool)
  }

  close() {
    return this.pool.end()
  }

  private row = (r: any): StoredRecord => ({ hash: r.hash, data: r.data, luid: r.luid, meta: r.meta })

  async get(ledger: string, kind: string, handle: string) {
    const { rows } = await this.pool.query('select * from records where ledger=$1 and kind=$2 and handle=$3', [ledger, kind, handle])
    return rows[0] && this.row(rows[0])
  }

  async insert(ledger: string, kind: string, r: StoredRecord) {
    const { rowCount } = await this.pool.query(
      `insert into records (ledger, kind, handle, luid, hash, data, meta) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (ledger, kind, handle) do nothing`,
      [ledger, kind, r.data.handle, r.luid, r.hash, r.data, r.meta],
    )
    return rowCount === 1
  }

  async list(ledger: string, kind: string) {
    const { rows } = await this.pool.query('select * from records where ledger=$1 and kind=$2 order by seq', [ledger, kind])
    return rows.map(this.row)
  }

  async getKey(ledger: string) {
    const { rows } = await this.pool.query('select key from ledger_keys where ledger=$1', [ledger])
    return rows[0]?.key as KeyPair | undefined
  }

  async putKey(ledger: string, key: KeyPair) {
    await this.pool.query('insert into ledger_keys (ledger, key) values ($1,$2) on conflict (ledger) do update set key=excluded.key', [ledger, key])
  }
}
