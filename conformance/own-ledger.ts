// Keeps only the exchanges of one run: those addressed to (or creating) a ledger whose
// handle starts with `open-ledger-conf-<run>`. A recording shared a proxy with another
// run once (access4); this makes that impossible to keep by accident.
//
//   tsx conformance/own-ledger.ts <file.jsonl> <run>
import { readFileSync, writeFileSync } from 'node:fs'

const [file, run] = process.argv.slice(2)
const prefix = `open-ledger-conf-${run}`
const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
const ledgerOf = (x: any): string => x.req.headers['x-ledger'] ?? x.req.body?.data?.handle ?? ''
const kept = lines.map((l) => JSON.parse(l)).filter((x) => ledgerOf(x).startsWith(prefix))
writeFileSync(file, kept.map((x, seq) => JSON.stringify({ ...x, seq })).join('\n') + '\n')
if (kept.length !== lines.length) console.error(`dropped ${lines.length - kept.length} exchanges of other runs from ${file}`)
