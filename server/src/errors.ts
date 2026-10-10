// Ledger errors. The `reason` codes and HTTP statuses are the compatibility contract:
// clients branch on them. Each one used here has been observed on the reference
// ledger (see conformance/fixtures). `detail` is human text and is matched loosely,
// but the wording is kept identical where it has been observed.

export class LedgerError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly detail: string,
    readonly custom?: Record<string, unknown>,
  ) {
    super(detail)
  }
}

export const errors = {
  routeNotFound: (detail = 'Route not found') => new LedgerError(404, 'api.route-not-found', detail),
  // Recorded (ledgers): a ledger route without `x-ledger`, and `x-ledger` where none may be.
  ledgerNotSet: () => new LedgerError(404, 'api.route-not-found', 'Active ledger is not set!'),
  noTenantAllowed: () =>
    new LedgerError(422, 'api.no-tenant-allowed', 'This endpoint is not available on a ledger-scoped URL or with an X-Ledger header. Connect to the base server URL and retry.'),
  ledgerNotHosted: () => new LedgerError(404, 'api.route-not-found', 'Server does not host requested ledger'),
  notFound: (kind: string) => new LedgerError(404, 'record.not-found', `${kind} not found`),
  duplicated: (kind: string, handle: string) =>
    new LedgerError(409, 'record.duplicated', `${kind} with handle ${handle} already exists.`),
  signatureMissing: () => new LedgerError(422, 'crypto.signature-missing', 'Ledger mutations must be signed.'),
  signatureInvalid: (key: string) => new LedgerError(422, 'crypto.signature-invalid', `Invalid signature for key: ${key}`),
  hashInvalid: (hash: string) => new LedgerError(422, 'crypto.hash-invalid', `Invalid record hash: ${hash}`),
  parentHashInvalid: () => new LedgerError(422, 'crypto.parent-hash-invalid', "Hash verification failed, hashes don't match"),
  // Not yet observed on the reference; wording is ours.
  dropRejected: (detail: string) => new LedgerError(422, 'record.drop-rejected', detail),
  changeNotFound: () => new LedgerError(404, 'record.not-found', 'Change not found'),
  unauthorized: () => new LedgerError(401, 'auth.unauthorized', 'Invalid token.'),
  // Observed for create and read, whether the ledger gate or the rules refused.
  forbidden: (action: string, record: string) => new LedgerError(403, 'auth.forbidden', `Cannot ${action} ${record}.`),
  // Adding a proof to an intent is checked by its own builder (recorded, bproofs): an
  // error for each rule that matches but for its signer, after two the reference always
  // lists (seemingly the implicit ledger-owner and record-owner checks).
  proofForbidden: (misses: number) => new LedgerError(403, 'auth.forbidden', 'Missing permissions', { errors: Array(2 + misses).fill('Cannot find required signer.') }),
}
