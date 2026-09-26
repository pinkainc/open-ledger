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

type Exchange = { seq: number; req: any; res: { status: number; headers: Record<string, string>; body: any } }

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
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) return '<moment>'
    if (/^\$[a-z]{3}\.-[\w-]{16}$/.test(v)) return token(`luid:${v.slice(1, 4)}`, v)
    if (/^-[\w-]{16}$/.test(v)) return token('thread', v)
    if (/^(deb|cre)_[A-Za-z0-9]{17}$/.test(v)) return token(`entry:${v.slice(0, 3)}`, v)
    if (/^[0-9a-f]{64}$/.test(v)) return '<hex64>'
    if (/^[A-Za-z0-9+/]{86}==$/.test(v)) return '<signature>'
    if (/^[A-Za-z0-9+/]{43}=$/.test(v)) return token('key', v)
    const lh = v.match(ledgerHandle)
    if (lh) return v.replace(lh[0], '<ledger>')
    return v
  }
  const walk = (x: any): any => {
    if (typeof x === 'string') return value(x)
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') {
      const out: any = {}
      for (const k of Object.keys(x).sort()) {
        if (k === 'trace') continue
        const v = walk(x[k])
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
const ref = load(refFile), cand = load(candFile)

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

let pass = 0
let diverged = 0
const n = Math.max(ref.length, cand.length)
for (let i = 0; i < n; i++) {
  const r = ref[i], c = cand[i]
  const label = r ? `${r.req.method} ${nr(r.req.url)}` : `${c.req.method} ${nc(c.req.url)}`
  if (!r || !c) {
    console.log(`FAIL  #${i} ${label}: only in ${r ? 'reference' : 'candidate'}`)
    continue
  }
  const rb = nr(r.res.body), cb = nc(c.res.body)
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
    ...(r.res.status !== c.res.status ? [`status: ${r.res.status} ≠ ${c.res.status}`] : []),
    ...diff(rb, cb),
  ]
  if (hard.length && deliberate.has(i)) {
    diverged++
    console.log(`diff  #${i} ${label} — deliberate: ${deliberate.get(i)}`)
  } else if (hard.length) {
    console.log(`FAIL  #${i} ${label} (${r.res.status})`)
    for (const d of hard) console.log(`        ${d}`)
  } else {
    pass++
    console.log(`pass  #${i} ${label} (${r.res.status})`)
  }
  for (const s of soft) console.log(`        ~ ${s}`)
}
const note = diverged ? `, ${diverged} deliberately differ (conformance/divergences.json)` : ''
console.log(`\n${pass}/${n} exchanges match the reference${note}`)
process.exit(pass + diverged === n ? 0 : 1)
