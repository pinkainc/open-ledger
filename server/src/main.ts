// Entry point. Each ledger holds its own signers (created with the ledger), so the
// server itself has no key. Postgres when DATABASE_URL is set, memory otherwise.
import { buildApp } from './app.js'
import { Core } from './core.js'
import { PgStore } from './pg-store.js'
import { MemoryStore } from './store.js'

const PORT = Number(process.env.PORT ?? 4620)
const url = process.env.DATABASE_URL

const store = url ? await PgStore.connect(url) : new MemoryStore()
const core = new Core(store)
const app = buildApp({ store, core })
await app.listen({ port: PORT, host: '127.0.0.1' })
await core.resume()
console.error(`open-ledger on :${PORT} (${url ? 'postgres' : 'memory'})`)
