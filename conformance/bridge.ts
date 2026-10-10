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
import { hashData, serverProof } from '../server/src/crypto.js'

/** What the bridge answers to a prepare: sign `prepared`, sign `failed`, fail the HTTP call first, or accept and never report. */
export type Decision =
  | { status: 'prepared' }
  | { status: 'failed'; reason: string; detail: string }
  | { httpFirst: number; then: Decision }
  | { silent: true }
  /** Answer this HTTP status for as long as `while()` holds, then decide `then`. */
  | { httpWhile: number; while: () => boolean; then: Decision }

export type BridgeSpec = {
  handle: string
  keyPair: any
  /** Mount point on the shared port, e.g. `/bank1` (calls then arrive at /bank1/v2/…); '' for one bridge. */
  prefix?: string
  /** Decides the answer to a prepare call, by entry. */
  decide: (entry: any) => Decision
  /** Whether to report a commit or abort; default: report. `'hold'` keeps the report until `release()`. */
  report?: (entry: string, action: 'commit' | 'abort', intent: any) => boolean | 'hold'
  /** Request headers (lower case) logged with each call as `seen`, for `secure` rules. */
  headers?: string[]
  /** An OAuth2 token endpoint at `{prefix}/oauth/token`, answering this body. */
  token?: Record<string, unknown>
  /**
   * Lists the bridge serves (traits `anchors`, `domains`): for a call it answers, the
   * records; the bridge replies 200 with them as a list signed by its key.
   */
  lists?: (method: string, path: string, body: any) => unknown[] | undefined
  /**
   * Any other call (anchor forwarding): the status and either a plain body or `signed`,
   * a record (`data`, `meta`) the bridge answers with its own proof appended.
   */
  serve?: (method: string, path: string, body: any) => { status: number; body?: unknown; signed?: { data: unknown; meta?: any } } | undefined
  /** HTTP status for an effect call `POST /v2/effects/{effect}` (trait `events`); default 202. */
  effect?: (effect: string, event: any) => number
  /** After answering an effect call 2xx: what the bridge then does, e.g. sign proofs on a report (reports). */
  afterEffect?: (effect: string, event: any, bridge: { sdk: any; keyPair: any; log: (x: unknown) => void }) => Promise<void>
}

export type BridgeOptions = {
  port: number
  out: string
  ledger: string
  /** Where proofs are sent: the ledger without the recording proxy. */
  server: string
} & Omit<BridgeSpec, 'prefix'>

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })

export async function startBridge(o: BridgeOptions) {
  return startBridges({ ...o, bridges: [{ handle: o.handle, keyPair: o.keyPair, decide: o.decide, report: o.report, lists: o.lists }] })
}

/**
 * Several bridges on one port, told apart by path prefix. With more than one, every
 * log line names the bridge it belongs to.
 */
export async function startBridges(o: {
  port: number
  out: string
  ledger: string
  server: string
  bridges: BridgeSpec[]
  /** Webhook endpoints of effects, under `/hooks/` on the same port: the HTTP status to answer. */
  hooks?: (path: string, event: any) => number
  /** Files served by `GET /files/<name>` on the same port (report assets), logged like hooks. */
  files?: Record<string, string>
}) {
  let seq = 0
  const many = o.bridges.length > 1
  const log = (b: BridgeSpec, x: unknown) => appendFileSync(o.out, JSON.stringify({ seq: seq++, ...(many ? { bridge: b.handle } : {}), ...(x as object) }) + '\n')
  const sdks = new Map(
    o.bridges.map((b) => [
      b.handle,
      new LedgerSdk({
        server: o.server,
        ledger: o.ledger,
        secure: { iss: b.handle, sub: `bridge:${b.handle}`, aud: o.ledger, exp: 3600, createHsh: false, kid: b.keyPair.public, keyPair: b.keyPair } as any,
      }) as any,
    ]),
  )
  const failedOnce = new Set<string>()
  const held: (() => Promise<void>)[] = []
  // Core ids numbered in order of first use, so they compare across runs.
  const coreIds = new Map<string, string>()
  const coreId = (handle: string) => coreIds.get(handle) ?? (coreIds.set(handle, `core-${coreIds.size + 1}`), coreIds.get(handle)!)

  async function sign(b: BridgeSpec, intent: any, custom: Record<string, unknown>) {
    await new Promise((r) => setTimeout(r, 200))
    try {
      const res = await sdks.get(b.handle).intent.from(intent).sign([{ keyPair: b.keyPair, custom: { ...custom, moment: new Date().toISOString() } }]).send()
      log(b, { proof: custom, answer: res.response.status })
    } catch (e: any) {
      const res = e?.custom?.causedBy?.response
      log(b, { proof: custom, answer: res?.status, error: res?.data?.data ?? e?.message })
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
    const tokenOf = o.bridges.find((x) => x.token && url === `${x.prefix ?? ''}/oauth/token`)
    if (tokenOf) {
      log(tokenOf, { token: { method: req.method, authorization: req.headers.authorization, type: req.headers['content-type'], body: text } })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(tokenOf.token))
      return
    }
    if (url.startsWith('/files/')) {
      const file = o.files?.[decodeURIComponent(url.slice('/files/'.length))]
      const status = req.method === 'GET' && file !== undefined ? 200 : 404
      appendFileSync(o.out, JSON.stringify({ seq: seq++, file: url, req: { method: req.method, url, headers: req.headers }, res: { status } }) + '\n')
      res.statusCode = status
      if (status === 200) res.setHeader('content-type', 'text/csv')
      res.end(status === 200 ? file : undefined)
      return
    }
    if (url.startsWith('/hooks/')) {
      const status = req.method === 'POST' ? (o.hooks?.(url, body) ?? 202) : 404
      appendFileSync(o.out, JSON.stringify({ seq: seq++, hook: url, req: { method: req.method, url, headers: req.headers, body }, res: { status } }) + '\n')
      res.statusCode = status
      res.end()
      return
    }
    const b = o.bridges.find((x) => url.startsWith(`${x.prefix ?? ''}/v2/`)) ?? o.bridges[0]
    const path = url.slice((b.prefix ?? '').length)
    // `{server}` ends in /v2; the SDK mounts /credits, /debits and /intents under it.
    const m = path.match(/^\/v2\/(debits|credits)(?:\/([^/]+)\/(commit|abort))?$/)
    let status = 404
    let after: (() => Promise<void>) | undefined
    if (m && req.method === 'POST') {
      const [, , handle, action] = m
      const entry = body?.data
      const intent = entry?.intent
      status = 202
      if (!action) {
        let d = b.decide(entry)
        if ('httpWhile' in d) {
          if (d.while()) status = d.httpWhile
          d = d.then
        }
        if ('httpFirst' in d) {
          if (!failedOnce.has(entry.handle)) {
            failedOnce.add(entry.handle)
            status = d.httpFirst
          }
          d = d.then
        }
        const decision = d as Exclude<Decision, { httpFirst: number } | { httpWhile: number }>
        if (status === 202 && !('silent' in decision))
          after = () =>
            sign(b, intent, decision.status === 'prepared' ? { handle: entry.handle, status: 'prepared', coreId: coreId(entry.handle) } : { handle: entry.handle, ...decision })
      } else {
        const report = b.report?.(handle, action as 'commit' | 'abort', intent) ?? true
        const send = () => sign(b, intent, { handle, status: action === 'commit' ? 'committed' : 'aborted', coreId: coreId(handle) })
        if (report === 'hold') held.push(send)
        else if (report) after = send
      }
    } else if (req.method === 'POST' && path.startsWith('/v2/effects/')) {
      const effect = decodeURIComponent(path.slice('/v2/effects/'.length))
      status = b.effect?.(effect, body) ?? 202
      if (b.afterEffect && status < 300) after = () => b.afterEffect!(effect, body, { sdk: sdks.get(b.handle), keyPair: b.keyPair, log: (x) => log(b, x) })
    } else if (req.method === 'PUT' && path.startsWith('/v2/intents/')) {
      status = 200
    }
    let reply: unknown
    const served = status === 404 ? b.serve?.(req.method ?? '', path, body) : undefined
    if (served) {
      status = served.status
      if (served.signed) {
        const hash = hashData(served.signed.data)
        const meta = served.signed.meta ?? {}
        reply = { hash, data: served.signed.data, meta: { ...meta, proofs: [...(meta.proofs ?? []), serverProof(hash, { moment: new Date().toISOString() }, b.keyPair, b.handle)] } }
      } else reply = served.body
    }
    const listed = status === 404 && !served ? b.lists?.(req.method ?? '', path, body) : undefined
    if (listed) {
      status = 200
      const hash = hashData(listed)
      reply = { hash, data: listed, meta: { proofs: [serverProof(hash, { moment: new Date().toISOString() }, b.keyPair, b.handle)] } }
    }
    const seen = b.headers && Object.fromEntries(b.headers.map((h) => [h, req.headers[h] ?? null]))
    log(b, { req: { method: req.method, url, headers: req.headers, body }, res: { status }, ...(seen ? { seen } : {}) })
    res.statusCode = status
    if (reply) res.setHeader('content-type', 'application/json')
    res.end(reply ? JSON.stringify(reply) : undefined)
    if (after) void after()
  })
  await new Promise<void>((r) => server.listen(o.port, '127.0.0.1', () => r()))
  return {
    close: () => new Promise<void>((r) => server.close(() => r())),
    /** Sends the reports held back so far, in order. */
    release: async () => {
      for (const send of held.splice(0)) await send()
    },
  }
}
