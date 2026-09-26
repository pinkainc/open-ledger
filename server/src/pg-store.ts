// Postgres store. Records keep their wire form in jsonb; the columns beside it exist
// for identity and ordering. Handles are unique per (ledger, kind), luids globally.
import pg from 'pg'
import type { KeyPair } from './crypto.js'
import { keyOf, type BalanceRow, type LimitRow, type Store, type StoredRecord } from './store.js'

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
  ledger text  not null,
  signer text  not null default 'system',
  key    jsonb not null,
  primary key (ledger, signer)
);
create table if not exists balances (
  seq    bigserial primary key,
  ledger text  not null,
  luid   text  not null unique,
  wallet text  not null,
  symbol text  not null,
  schema text  not null,
  row    jsonb not null,
  unique (ledger, wallet, symbol, schema)
);
create table if not exists changes (
  seq    bigserial primary key,
  ledger text  not null,
  kind   text  not null,
  handle text  not null,
  record jsonb not null
);
create index if not exists changes_by_record on changes (ledger, kind, handle, seq);
create table if not exists limits (
  seq    bigserial primary key,
  ledger text  not null,
  wallet text  not null,
  symbol text  not null,
  metric text  not null,
  row    jsonb not null,
  unique (ledger, wallet, symbol, metric)
);
create table if not exists marks (
  ledger text not null,
  key    text not null,
  primary key (ledger, key)
);
`

type Queryable = pg.Pool | pg.PoolClient

export class PgStore implements Store {
  private constructor(
    private readonly db: Queryable,
    private readonly pool: pg.Pool,
  ) {}

  static async connect(url: string) {
    const pool = new pg.Pool({ connectionString: url, max: 20 })
    // Concurrent test processes may race to create the schema; serialise that too.
    const c = await pool.connect()
    try {
      await c.query('select pg_advisory_lock(815)')
      await c.query(SCHEMA)
    } finally {
      await c.query('select pg_advisory_unlock(815)')
      c.release()
    }
    return new PgStore(pool, pool)
  }

  close() {
    return this.pool.end()
  }

  private row = (r: any): StoredRecord => ({ hash: r.hash, data: r.data, luid: r.luid, meta: r.meta })

  async get(ledger: string, kind: string, handle: string) {
    const { rows } = await this.db.query('select * from records where ledger=$1 and kind=$2 and handle=$3', [ledger, kind, handle])
    return rows[0] && this.row(rows[0])
  }

  async getByLuid(ledger: string, kind: string, luid: string) {
    const { rows } = await this.db.query('select * from records where ledger=$1 and kind=$2 and luid=$3', [ledger, kind, luid])
    return rows[0] && this.row(rows[0])
  }

  async insert(ledger: string, kind: string, r: StoredRecord) {
    const { rowCount } = await this.db.query(
      `insert into records (ledger, kind, handle, luid, hash, data, meta) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (ledger, kind, handle) do nothing`,
      [ledger, kind, keyOf(r), r.luid, r.hash, r.data, r.meta],
    )
    return rowCount === 1
  }

  async update(ledger: string, kind: string, r: StoredRecord) {
    const { rowCount } = await this.db.query('update records set hash=$4, data=$5, meta=$6 where ledger=$1 and kind=$2 and handle=$3', [
      ledger,
      kind,
      keyOf(r),
      r.hash,
      r.data,
      r.meta,
    ])
    if (rowCount !== 1) throw new Error(`update of missing ${kind} ${keyOf(r)}`)
  }

  async remove(ledger: string, kind: string, handle: string) {
    await this.db.query('delete from records where ledger=$1 and kind=$2 and handle=$3', [ledger, kind, handle])
  }

  async addChange(ledger: string, kind: string, handle: string, change: StoredRecord) {
    await this.db.query('insert into changes (ledger, kind, handle, record) values ($1,$2,$3,$4)', [ledger, kind, handle, change])
  }

  async changes(ledger: string, kind: string, handle: string) {
    const { rows } = await this.db.query('select record from changes where ledger=$1 and kind=$2 and handle=$3 order by seq', [ledger, kind, handle])
    return rows.map((r) => r.record as StoredRecord)
  }

  async list(ledger: string, kind: string) {
    const { rows } = await this.db.query('select * from records where ledger=$1 and kind=$2 order by seq', [ledger, kind])
    return rows.map(this.row)
  }

  async getKey(ledger: string, signer = 'system') {
    const { rows } = await this.db.query('select key from ledger_keys where ledger=$1 and signer=$2', [ledger, signer])
    return rows[0]?.key as KeyPair | undefined
  }

  async putKey(ledger: string, key: KeyPair, signer = 'system') {
    await this.db.query(
      'insert into ledger_keys (ledger, signer, key) values ($1,$2,$3) on conflict (ledger, signer) do update set key=excluded.key',
      [ledger, signer, key],
    )
  }

  async balances(ledger: string, wallet: string) {
    const { rows } = await this.db.query('select row from balances where ledger=$1 and wallet=$2 order by seq', [ledger, wallet])
    return rows.map((r) => r.row as BalanceRow)
  }

  async putBalance(ledger: string, b: BalanceRow) {
    await this.db.query(
      `insert into balances (ledger, luid, wallet, symbol, schema, row) values ($1,$2,$3,$4,$5,$6)
       on conflict (luid) do update set row=excluded.row`,
      [ledger, b.luid, b.data.wallet, b.data.symbol, b.data.schema, b],
    )
  }

  async limits(ledger: string, wallet: string) {
    const { rows } = await this.db.query('select row from limits where ledger=$1 and wallet=$2 order by seq', [ledger, wallet])
    return rows.map((r) => r.row as LimitRow)
  }

  async putLimit(ledger: string, l: LimitRow) {
    await this.db.query(
      `insert into limits (ledger, wallet, symbol, metric, row) values ($1,$2,$3,$4,$5)
       on conflict (ledger, wallet, symbol, metric) do update set row=excluded.row`,
      [ledger, l.data.wallet, l.data.symbol, l.data.metric, l],
    )
  }

  // One Postgres transaction per call, holding a ledger-wide advisory lock until
  // commit, so money-moving work on a ledger is serialised across processes too.
  async once(ledger: string, key: string) {
    const { rowCount } = await this.db.query('insert into marks (ledger, key) values ($1, $2) on conflict do nothing', [ledger, key])
    return rowCount === 1
  }

  async transaction<T>(ledger: string, fn: (tx: Store) => Promise<T>): Promise<T> {
    if (this.db !== this.pool) return fn(this) // already inside one
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [ledger])
      const out = await fn(new PgStore(client, this.pool))
      await client.query('commit')
      return out
    } catch (e) {
      await client.query('rollback')
      throw e
    } finally {
      client.release()
    }
  }
}
