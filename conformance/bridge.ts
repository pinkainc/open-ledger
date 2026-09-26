// A bridge for conformance scenarios. It records every call a ledger makes to it and
// answers the way @minka/bridge-sdk does: 202 with no body, then — asynchronously — a
// proof on the intent (`POST /intents/{handle}/proofs`) saying what the bridge did.
//
// Recording against the sandbox, the ledger reaches it through a public tunnel
// (run.sh); checking our server, directly. The calls it receives are written to OUT as
// JSONL, one line per call, next to the proofs it sent back, so the whole conversation
// between ledger and bridge can be compared like the client's.
import { createServer, type IncomingMessage } from 'node:http'
import { appendFileSync } from 'node:fs'
import { LedgerSdk } from '@minka/ledger-sdk'

/** What the bridge answers to a prepare: sign `prepared`, sign `failed`, or fail the HTTP call first. */
export type Decision = { status: 'prepared' } | { status: 'failed'; reason: string; detail: string } | { httpFirst: number; then: Decision }

export type BridgeOptions = {
  port: number
  out: string
  ledger: string
  /** Where proofs are sent: the ledger without the recording proxy. */
  server: string
  handle: string
  keyPair: any
  /** Decides the answer to a prepare call, by entry. */
  decide: (entry: any) => Decision
}

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })

export async function startBridge(o: BridgeOptions) {
  let seq = 0
  const log = (x: unknown) => appendFileSync(o.out, JSON.stringify({ seq: seq++, ...(x as object) }) + '\n')
  const sdk: any = new LedgerSdk({
    server: o.server,
    ledger: o.ledger,
    secure: { iss: o.handle, sub: `bridge:${o.handle}`, aud: o.ledger, exp: 3600, createHsh: false, kid: o.keyPair.public, keyPair: o.keyPair } as any,
  })
  const failedOnce = new Set<string>()
  // Core ids numbered in order of first use, so they compare across runs.
  const coreIds = new Map<string, string>()
  const coreId = (handle: string) => coreIds.get(handle) ?? (coreIds.set(handle, `core-${coreIds.size + 1}`), coreIds.get(handle)!)

  async function sign(intent: any, custom: Record<string, unknown>) {
    await new Promise((r) => setTimeout(r, 200))
    try {
      const res = await sdk.intent.from(intent).sign([{ keyPair: o.keyPair, custom: { ...custom, moment: new Date().toISOString() } }]).send()
      log({ proof: custom, answer: res.response.status })
    } catch (e: any) {
      const res = e?.custom?.causedBy?.response
      log({ proof: custom, answer: res?.status, error: res?.data?.data ?? e?.message })
    }
  }

  const server = createServer(async (req, res) => {
    const text = await read(req)
    let body: any
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    const url = req.url ?? ''
    // `{server}` ends in /v2; the SDK mounts /credits, /debits and /intents under it.
    const m = url.match(/^\/v2\/(debits|credits)(?:\/([^/]+)\/(commit|abort))?$/)
    let status = 404
    let after: (() => Promise<void>) | undefined
    if (m && req.method === 'POST') {
      const [, , handle, action] = m
      const entry = body?.data
      const intent = entry?.intent
      status = 202
      if (!action) {
        let d = o.decide(entry)
        if ('httpFirst' in d) {
          if (!failedOnce.has(entry.handle)) {
            failedOnce.add(entry.handle)
            status = d.httpFirst
          }
          d = d.then
        }
        const decision = d as Exclude<Decision, { httpFirst: number }>
        if (status === 202)
          after = () =>
            sign(intent, decision.status === 'prepared' ? { handle: entry.handle, status: 'prepared', coreId: coreId(entry.handle) } : { handle: entry.handle, ...decision })
      } else {
        after = () => sign(intent, { handle, status: action === 'commit' ? 'committed' : 'aborted', coreId: coreId(handle) })
      }
    } else if (req.method === 'PUT' && url.startsWith('/v2/intents/')) {
      status = 200
    }
    log({ req: { method: req.method, url, headers: req.headers, body }, res: { status } })
    res.statusCode = status
    res.end()
    if (after) void after()
  })
  await new Promise<void>((r) => server.listen(o.port, '127.0.0.1', () => r()))
  return { close: () => new Promise<void>((r) => server.close(() => r())) }
}
