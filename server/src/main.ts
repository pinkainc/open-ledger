// Entry point. Each ledger holds its own signers (created with the ledger), so the
// server itself has no key. Postgres when DATABASE_URL is set, memory otherwise.
import { buildApp } from './app.js'
import { Core } from './core.js'
import { PgStore } from './pg-store.js'
import { MemoryStore } from './store.js'

const PORT = Number(process.env.PORT ?? 4620)
const url = process.env.DATABASE_URL

const store = url ? await PgStore.connect(url) : new MemoryStore()
// OPEN_LEDGER_MINUTE_MS shortens intent expiry for conformance runs; leave it unset.
const minuteMs = process.env.OPEN_LEDGER_MINUTE_MS ? Number(process.env.OPEN_LEDGER_MINUTE_MS) : undefined
const core = new Core(store, { minuteMs })
// PUBLIC_URL: the address clients use (…/api/v2), when behind a proxy.
const app = buildApp({ store, core, server: { handle: process.env.SERVER_HANDLE, url: process.env.PUBLIC_URL } })
// OPEN_LEDGER_LOG=1 prints one line per request (method, url, status) to stderr.
if (process.env.OPEN_LEDGER_LOG) app.addHook('onResponse', async (req, reply) => console.error(`${req.method} ${req.url} ${reply.statusCode}`))
await app.listen({ port: PORT, host: '127.0.0.1' })
await core.resume()
core.startExpiry()
console.error(`open-ledger on :${PORT} (${url ? 'postgres' : 'memory'})`)
