// Entry point. Each ledger holds its own signers (created with the ledger), so the
// server itself has no key. Postgres when DATABASE_URL is set, memory otherwise.
import { buildApp } from './app.js'
import { Core } from './core.js'
import { PgStore } from './pg-store.js'
import { MemoryStore } from './store.js'
import { SecretBox } from './secrets.js'

const PORT = Number(process.env.PORT ?? 4620)
const url = process.env.DATABASE_URL

const store = url ? await PgStore.connect(url) : new MemoryStore()
// OPEN_LEDGER_MINUTE_MS shortens intent expiry for conformance runs; leave it unset.
const minuteMs = process.env.OPEN_LEDGER_MINUTE_MS ? Number(process.env.OPEN_LEDGER_MINUTE_MS) : undefined
// OPEN_LEDGER_MASTER_KEY seals the secrets records refer to (secrets.ts).
const secrets = new SecretBox()
if (secrets.ephemeral && url) console.error('warning: OPEN_LEDGER_MASTER_KEY is not set; secrets stored now cannot be read after a restart')
// OPEN_LEDGER_DELIVERY_MAX_RETRIES: retries of a call to a bridge before giving up (5).
const maxRetries = process.env.OPEN_LEDGER_DELIVERY_MAX_RETRIES ? Number(process.env.OPEN_LEDGER_DELIVERY_MAX_RETRIES) : undefined
const core = new Core(store, { minuteMs, secrets, bridges: { maxRetries } })
// PUBLIC_URL: the address clients use (…/api/v2), when behind a proxy.
// OPEN_LEDGER_REPORTS_BUCKET: the bucket report assets must name; OPEN_LEDGER_REPORTS_DIR:
// where their files are served from (reports.ts).
const reports = { bucket: process.env.OPEN_LEDGER_REPORTS_BUCKET, dir: process.env.OPEN_LEDGER_REPORTS_DIR }
// OPEN_LEDGER_LEDGER_DROP=1 lets an owner drop a whole ledger; OPEN_LEDGER_JOURNAL=1 keeps
// the request journal. Both are off on the public reference, and by default here.
const ledgerDrop = process.env.OPEN_LEDGER_LEDGER_DROP === '1'
const journal = process.env.OPEN_LEDGER_JOURNAL === '1'
const app = buildApp({ store, core, server: { handle: process.env.SERVER_HANDLE, url: process.env.PUBLIC_URL }, reports, ledgerDrop, journal })
// OPEN_LEDGER_LOG=1 prints one line per request (method, url, status) to stderr.
if (process.env.OPEN_LEDGER_LOG) app.addHook('onResponse', async (req, reply) => console.error(`${req.method} ${req.url} ${reply.statusCode}`))
await app.listen({ port: PORT, host: '127.0.0.1' })
await core.resume()
core.startExpiry()
console.error(`open-ledger on :${PORT} (${url ? 'postgres' : 'memory'})`)
