// Entry point. Each ledger holds its own signer (created with the ledger), so the
// server itself has no key. Storage is in memory until L1.
import { buildApp } from './app.js'
import { MemoryStore } from './store.js'

const PORT = Number(process.env.PORT ?? 4620)

const app = buildApp({ store: new MemoryStore() })
await app.listen({ port: PORT, host: '127.0.0.1' })
console.error(`open-ledger on :${PORT}`)
