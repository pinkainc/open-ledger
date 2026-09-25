// Recording proxy. Forwards every request to TARGET unchanged and appends the full
// exchange to a JSONL file, so what the real ledger said becomes a fixture rather
// than something inferred from the docs.
//
//   TARGET=https://ldg-stg.one PORT=4610 OUT=exchanges.jsonl tsx conformance/proxy.ts
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const TARGET = process.env.TARGET ?? 'https://ldg-stg.one'
const PORT = Number(process.env.PORT ?? 4610)
const OUT = process.env.OUT ?? 'exchanges.jsonl'

// Hop-by-hop and transport headers say nothing about ledger behaviour.
const DROP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive'])

let seq = 0
createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const body = Buffer.concat(chunks).toString('utf8')

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k) && typeof v === 'string') headers[k] = v

  const upstream = await fetch(TARGET + req.url, {
    method: req.method,
    headers,
    body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
  })
  const text = await upstream.text()
  const resHeaders: Record<string, string> = {}
  upstream.headers.forEach((v, k) => {
    if (!DROP.has(k) && k !== 'content-encoding') resHeaders[k] = v
  })

  appendFileSync(
    OUT,
    JSON.stringify({
      seq: seq++,
      req: { method: req.method, url: req.url, headers, body: parse(body) },
      res: { status: upstream.status, headers: resHeaders, body: parse(text) },
    }) + '\n',
  )
  res.writeHead(upstream.status, resHeaders)
  res.end(text)
}).listen(PORT, () => console.error(`proxy :${PORT} -> ${TARGET}, recording to ${OUT}`))

function parse(s: string) {
  if (!s) return null
  try { return JSON.parse(s) } catch { return s }
}
