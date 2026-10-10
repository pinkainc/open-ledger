// Reports (`$rep`, docs: reporting/about-reports; recorded `reports`, `reports2`). A
// report is a record whose schema (`record: report`) gives its parameters in
// `data.custom`. Creating one raises `report-created`; a reporting bridge subscribed
// through an effect generates the files elsewhere and signs status proofs on the
// report, the last of them `completed` with `assets` (or `rejected`).
//
// What the ledger itself does, as recorded:
//
// - a status proof must follow the transition table below. A proof that names the
//   current status is answered 200 and dropped: no proof, no change, no event. Any
//   other move is 422 `record.update-rejected`.
// - `completed` with `assets` sets `meta.assets` (an empty list too). Each asset's
//   `output` is `gs://{bucket}/ledgers/{ledger}[/domains/{domain}]/schemas/{schema}/
//   reports/{luid}/assets/{file}`, `file` the asset's `handle`, `bucket` the
//   deployment's reporting bucket. The reference answers a bad asset with a 500; we
//   answer 422 `record.invalid` with its message (divergences.json).
//
// Where the files live is the reporting bridge's business. The reference reads them
// from its Google Cloud Storage bucket to serve `GET /reports/{id}/assets/{asset}`;
// this server serves them from a local directory when one is configured
// (OPEN_LEDGER_REPORTS_DIR, the object path under it), and otherwise says it has none.
import { LedgerError } from './errors.js'

export const REPORT_STATUSES = ['created', 'pending', 'completed', 'rejected', 'settled'] as const

// Recorded (reports2), every pair: besides staying, created → pending | rejected,
// pending → completed | rejected, completed → settled, rejected → pending | completed.
const NEXT: Record<string, string[]> = {
  created: ['pending', 'rejected'],
  pending: ['completed', 'rejected'],
  completed: ['settled'],
  rejected: ['pending', 'completed'],
  settled: [],
}

/** `false` when the proof repeats the current status (dropped); throws for a move the table refuses. */
export function statusChange(from: string, to: string) {
  if (from === to) return false
  if (!NEXT[from]?.includes(to)) throw new LedgerError(422, 'record.update-rejected', `Proof contains invalid status change, from ${from} to ${to}`)
  return true
}

const OUTPUT = /^gs:\/\/([^/]+)\/ledgers\/[^/]+(?:\/domains\/[^/]+)?\/schemas\/[^/]+\/reports\/[^/]+\/assets\/([^/]+)$/

/** Checks the assets of a `completed` proof (recorded: bucket, path shape, file name = handle). */
export function checkAssets(assets: unknown, bucket: string | undefined) {
  if (!Array.isArray(assets)) return
  for (const a of assets as { handle?: string; output?: unknown }[]) {
    const m = typeof a?.output === 'string' ? a.output.match(OUTPUT) : null
    if (!m) throw invalid(`Invalid gs URL: ${a?.output}`)
    if (bucket && m[1] !== bucket) throw invalid(`Error while validating asset, GCS URL bucket (${m[1]}) different than reporting bucket (${bucket})`)
    if (m[2] !== a.handle) throw invalid(`Error while validating asset, GCS URL filename (${m[2]}) different than asset handle (${a.handle})`)
  }
}
const invalid = (detail: string) => new LedgerError(422, 'record.invalid', detail)

/** The object path of an asset inside its bucket (`ledgers/…/assets/{file}`). */
export const objectPath = (output: string) => output.replace(/^gs:\/\/[^/]+\//, '')
