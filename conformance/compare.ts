// Compare two recordings of the same scenario: the reference ledger's and ours.
//
// Values that legitimately differ between runs (moments, luids, keys, hashes,
// signatures, the run's ledger handle) are replaced by placeholders numbered in order
// of first appearance, so identity is still checked: the same luid must come back
// where the same luid came back before. Cryptographic validity is not judged here;
// the server's own tests and the SDK's proof verification cover that.
//
// Strict: HTTP status, body shape, every normalised value.
// Soft (reported, not failed): error `detail` wording, which is human text.
// Ignored: `custom.trace` — the reference ledger leaks stack traces; we do not copy them.
//
//   tsx conformance/compare.ts <reference.jsonl> <candidate.jsonl>
import { readFileSync } from 'node:fs'

type Exchange = { seq: number; req: any; res: { status: number; headers: Record<string, string>; body: any }; proof?: any; answer?: number; error?: unknown; bridge?: string }

const load = (f: string): Exchange[] =>
  readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

function normaliser() {
  const maps: Record<string, Map<string, string>> = {}
  const token = (kind: string, v: string) => {
    const m = (maps[kind] ??= new Map())
    if (!m.has(v)) m.set(v, `<${kind}#${m.size}>`)
    return m.get(v)!
  }
  // Run ids are alphanumeric, so this stops before a suffix such as "-nope".
  const ledgerHandle = /open-ledger-conf-[0-9a-z]+/

  const value = (v: string): string => {
    // Core ids the test bridge hands out in order of arrival: racing prepares swap them.
    if (/^core-\d+$/.test(v)) return '<core-id>'
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) return '<moment>'
    if (/^\$[a-z]{3}\.-[\w-]{16}$/.test(v)) return token(`luid:${v.slice(1, 4)}`, v)
    if (/^-[\w-]{16}$/.test(v)) return token('thread', v)
    if (/^\{\{ secret\.[a-z0-9]+ \}\}$/.test(v)) return token('secret', v)
    if (/^(deb|cre)_[A-Za-z0-9]{17}$/.test(v)) return token(`entry:${v.slice(0, 3)}`, v)
    // Handles the ledger makes itself: event deliveries, intents of forward routes.
    if (/^[A-Za-z0-9]{17}$/.test(v)) return token('id', v)
    if (/^[0-9a-f]{64}$/.test(v)) return '<hex64>'
    if (/^[A-Za-z0-9+/]{86}==$/.test(v)) return '<signature>'
    if (/^[A-Za-z0-9+/]{43}=$/.test(v)) return token('key', v)
    // A token subject naming a key, as `bearer.sub` carries it on impersonated proofs.
    if (/^signer:[A-Za-z0-9+/]{43}=$/.test(v)) return `signer:${token('key', v.slice(7))}`
    // The bridge's address: a quick tunnel for the reference, localhost for us; with
    // several bridges on one port, a path prefix per bridge that is kept.
    const bridgeUrl = v.match(/^(?:https:\/\/[a-z0-9-]+\.trycloudflare\.com|http:\/\/127\.0\.0\.1:\d+)((?:\/[a-z0-9]+)?)\/v2$/)
    if (bridgeUrl) return `<bridge-url>${bridgeUrl[1]}`
    // Other addresses on the bridge's host, e.g. an OAuth2 token endpoint.
    const bridgeHost = v.match(/^(?:https:\/\/[a-z0-9-]+\.trycloudflare\.com|http:\/\/127\.0\.0\.1:\d+)(\/.*)$/)
    if (bridgeHost) return `<bridge-host>${bridgeHost[1]}`
    const lh = v.match(ledgerHandle)
    if (lh) v = v.replace(lh[0], '<ledger>')
    // Entry handles inside paths, e.g. /v2/credits/cre_…/commit; ledger-made intent
    // handles inside error details ("… for intent 04VCsmXExKRbsoTqV.").
    return v
      .replace(/\b(deb|cre)_[A-Za-z0-9]{17}\b/g, (e) => token(`entry:${e.slice(0, 3)}`, e))
      .replace(/\b([Ii]ntent) ([A-Za-z0-9]{17})\b/g, (_, w, id) => `${w} ${token('id', id)}`)
      .replace(/\/intents\/([A-Za-z0-9]{17})$/, (_, id) => `/intents/${token('id', id)}`)
  }
  const walk = (x: any): any => {
    if (typeof x === 'string') return value(x)
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') {
      const out: any = {}
      for (const k of Object.keys(x).sort()) {
        if (k === 'trace') continue
        // Token times (epoch seconds) copied into impersonated proofs as `bearer.*`.
        const v = /^bearer\.(iat|exp|nbf)$/.test(k) && typeof x[k] === 'number' ? '<epoch>' : walk(x[k])
        // An error `custom` that held only the trace is empty once the trace is gone.
        if (k === 'custom' && v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue
        out[k] = v
      }
      return out
    }
    return x
  }
  return walk
}

function diff(a: any, b: any, path = ''): string[] {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return [`${path || '/'}: ${show(a)} ≠ ${show(b)}`]
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].flatMap((k) =>
      !(k in b) ? [`${path}/${k}: missing in candidate`] : !(k in a) ? [`${path}/${k}: extra in candidate`] : diff(a[k], b[k], `${path}/${k}`),
    )
  }
  return a === b ? [] : [`${path || '/'}: ${show(a)} ≠ ${show(b)}`]
}
const show = (v: any) => JSON.stringify(v)?.slice(0, 80)

const [refFile, candFile] = process.argv.slice(2)

// A bridge log interleaves by timing: a status notification may overtake a commit call,
// and a late notification may land among the next intent's calls. Compared in a
// canonical order instead: by intent (first appearance), then by phase.
function canonical(log: Exchange[]): Exchange[] {
  const intentOfEntry = new Map<string, string>()
  const intentOf = (x: any): string => {
    if (x.proof) return intentOfEntry.get(x.proof.handle) ?? ''
    // Token requests are ordered among themselves, ahead of the calls they authorise.
    if (x.token) return 'token'
    const d = x.req.body?.data
    const handle = d?.intent?.data?.handle ?? (x.req.method === 'PUT' ? d?.handle : '')
    if (d?.handle && d?.intent) intentOfEntry.set(d.handle, handle)
    return handle
  }
  const rank = (x: any): number => {
    if (x.proof) return ['prepared', 'failed'].includes(x.proof.status) ? 1 : 4
    if (x.token) return 0
    if (x.req.method === 'PUT') return x.req.body?.meta?.status === 'prepared' ? 2 : 5
    return x.req.body?.data?.action ? 3 : 0
  }
  // With several bridges, calls of one phase go out in parallel: bridge, then the
  // entry's schema, then the action, then the claims the entry stands for (its
  // `inputs`, fixed by the intent) break the tie before arrival order does.
  const inputsOf = new Map<string, string>()
  for (const x of log as any[]) {
    const d = x.req?.body?.data
    if (d?.handle && Array.isArray(d.inputs)) inputsOf.set(d.handle, JSON.stringify(d.inputs))
  }
  const entryOf = (x: any): string => x.proof?.handle ?? String(x.req?.url).match(/(?:deb|cre)_[A-Za-z0-9]{17}/)?.[0] ?? x.req?.body?.data?.handle ?? ''
  const tie = (x: any): string =>
    (x.proof
      ? `${x.bridge ?? ''} ${String(x.proof.handle).slice(0, 3)} ${x.proof.status}`
      : x.token
        ? `${x.bridge ?? ''} token`
        : `${x.bridge ?? ''} ${String(x.req.url).replace(/(deb|cre)_[A-Za-z0-9]{17}/g, '$1')}`) + ` ${inputsOf.get(entryOf(x)) ?? ''}`
  const order = new Map<string, number>()
  const keyed = log.map((x, i) => {
    const intent = intentOf(x)
    if (!order.has(intent)) order.set(intent, order.size)
    return { x, i, k: [order.get(intent)!, rank(x)], t: x.bridge ? tie(x) : '' }
  })
  const sorted = keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.t.localeCompare(b.t) || a.i - b.i).map((e) => e.x)
  // Token requests are compared by form, once each: the reference asked for a token
  // before seven of eight calls (secure), for no reason a recording shows. Every call's
  // `Authorization` header is still compared (`seen`).
  const tokens = new Set<string>()
  return sorted.filter((x: any) => !x.token || (!tokens.has(JSON.stringify(x.token)) && tokens.add(JSON.stringify(x.token))))
}
const bridgeFile = refFile.endsWith('.bridge.jsonl')
const ref = bridgeFile ? canonical(load(refFile)) : load(refFile)
const cand = bridgeFile ? canonical(load(candFile)) : load(candFile)

// Deliberate divergences: exchanges where we answer differently on purpose, each with
// the reason. They are reported, never counted as passes, and must still be listed
// here to not fail the run.
const fixtureName = refFile.split('/').pop()!.replace(/\.reference\.jsonl$/, '')
const divergences: { fixture: string; exchanges: number[]; what: string }[] = JSON.parse(
  readFileSync(new URL('./divergences.json', import.meta.url), 'utf8'),
)
const deliberate = new Map<number, string>()
for (const d of divergences) if (d.fixture === fixtureName) for (const i of d.exchanges) deliberate.set(i, d.what)
const nr = normaliser(), nc = normaliser()

// A bridge log (`*.bridge.jsonl`) holds the calls a ledger made to the bridge and the
// proofs the bridge sent back; what is compared there is the ledger's request.
const bridgeLog = bridgeFile
const subject = (x: any) =>
  !bridgeLog
    ? x.res.body
    : x.proof
      ? { proof: x.proof, answer: x.answer, error: x.error, bridge: x.bridge }
      : x.token
        ? { token: x.token, bridge: x.bridge }
        : { method: x.req.method, url: x.req.url, body: x.req.body, status: x.res.status, ...(x.seen ? { seen: x.seen } : {}) }
const title = (x: any, n: (v: any) => any) =>
  x.proof ? `proof ${x.bridge ? `${x.bridge} ` : ''}${x.proof.status}` : x.token ? `token ${x.bridge ?? ''}` : `${x.req.method} ${n(x.req.url)}`

// Reports of several bridges race: adjacent proofs by participants other than the
// ledger, with the same status, arrive in timing order on the reference as here.
// Sorted by signer, then entry kind, before comparing.
function settleRaces(x: any): any {
  if (Array.isArray(x)) return x.map(settleRaces)
  if (!x || typeof x !== 'object') return x
  const out: any = {}
  for (const [k, v] of Object.entries(x)) out[k] = settleRaces(v)
  // Delivery lists (`$evd`, newest first): a status notification and a commit go out
  // together, so their creation order is timing. Within an intent: final status,
  // command, `prepared` status, prepare.
  if (Array.isArray(out.data) && out.data.length && out.data.every((d: any) => String(d?.luid).startsWith('$evd.'))) {
    const group = new Map<string, number>()
    for (const d of out.data) if (!group.has(d.data.linked)) group.set(d.data.linked, group.size)
    const rank = (d: any) => {
      const o = d.meta?.output?.data ?? {}
      if (o.action) return 1
      if (o.schema === 'debit' || o.schema === 'credit') return 3
      return d.meta?.output?.meta?.status === 'prepared' ? 2 : 0
    }
    out.data = out.data.map((d: any, i: number) => ({ d, i })).sort((a: any, b: any) => group.get(a.d.data.linked)! - group.get(b.d.data.linked)! || rank(a.d) - rank(b.d) || a.i - b.i).map((x: any) => x.d)
  }
  if (Array.isArray(out.proofs)) {
    const external = (p: any) => p?.signer && !['system', 'core'].includes(p.signer) && p.custom?.handle
    const key = (p: any) => `${p.signer} ${String(p.custom.handle).slice(0, 3)}`
    // Then by the entry's place in the trail (its `resolved` proof), not its handle.
    const place = (p: any) => out.proofs.findIndex((q: any) => q?.custom?.handle === p.custom.handle)
    const ps = [...out.proofs]
    for (let i = 0; i < ps.length; ) {
      let j = i
      while (j < ps.length && external(ps[j]) && ps[j].custom.status === ps[i].custom?.status) j++
      if (j - i > 1) ps.splice(i, j - i, ...ps.slice(i, j).sort((a, b) => key(a).localeCompare(key(b)) || place(a) - place(b)))
      i = Math.max(j, i + 1)
    }
    out.proofs = ps
  }
  return out
}

let pass = 0
let diverged = 0
const n = Math.max(ref.length, cand.length)
for (let i = 0; i < n; i++) {
  const r = ref[i], c = cand[i]
  const label = r ? title(r, nr) : title(c, nc)
  if (!r || !c) {
    if (deliberate.has(i)) {
      diverged++
      console.log(`diff  #${i} ${label}: only in ${r ? 'reference' : 'candidate'} — deliberate: ${deliberate.get(i)}`)
    } else console.log(`FAIL  #${i} ${label}: only in ${r ? 'reference' : 'candidate'}`)
    continue
  }
  const rb = nr(settleRaces(subject(r))), cb = nc(settleRaces(subject(c)))
  // `detail` is human text: a wording difference is reported but does not fail.
  const soft: string[] = []
  // Keys and hashes embedded in the text differ per run; compare the wording around them.
  const scrub = (t: unknown) =>
    typeof t === 'string' ? t.replace(/[A-Za-z0-9+/]{43}=/g, '<key>').replace(/[0-9a-f]{64}/g, '<hex64>') : t
  const rd = scrub(rb?.data?.detail), cd = scrub(cb?.data?.detail)
  if (rd !== undefined && cd !== undefined) {
    if (rd !== cd) soft.push(`detail: ${show(rd)} vs ${show(cd)}`)
    delete rb.data.detail
    delete cb.data.detail
  }
  const hard = [
    ...(!bridgeLog && r.res.status !== c.res.status ? [`status: ${r.res.status} ≠ ${c.res.status}`] : []),
    ...diff(rb, cb),
  ]
  if (hard.length && deliberate.has(i)) {
    diverged++
    console.log(`diff  #${i} ${label} — deliberate: ${deliberate.get(i)}`)
  } else if (hard.length) {
    console.log(`FAIL  #${i} ${label} (${r.res?.status ?? r.answer})`)
    for (const d of hard) console.log(`        ${d}`)
  } else {
    pass++
    console.log(`pass  #${i} ${label} (${r.res?.status ?? r.answer})`)
  }
  for (const s of soft) console.log(`        ~ ${s}`)
}
const note = diverged ? `, ${diverged} deliberately differ (conformance/divergences.json)` : ''
console.log(`\n${pass}/${n} exchanges match the reference${note}`)
process.exit(pass + diverged === n ? 0 : 1)
