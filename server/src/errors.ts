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
  ledgerNotHosted: () => new LedgerError(404, 'api.route-not-found', 'Server does not host requested ledger'),
  notFound: (kind: string) => new LedgerError(404, 'record.not-found', `${kind} not found`),
  duplicated: (kind: string, handle: string) =>
    new LedgerError(409, 'record.duplicated', `${kind} with handle ${handle} already exists.`),
  // Mirrors the reference ledger, which validates bodies with express-openapi-validator
  // and reports the first missing property in that library's words.
  missingProperty: (parent: string, prop: string) =>
    new LedgerError(422, 'record.schema-invalid', `Schema validation error: request/body${parent} must have required property '${prop}'`, {
      errors: [{ path: `/body${parent}/${prop}`, message: `must have required property '${prop}'`, errorCode: 'required.openapi.validation' }],
    }),
  signatureMissing: () => new LedgerError(422, 'crypto.signature-missing', 'Ledger mutations must be signed.'),
  signatureInvalid: (key: string) => new LedgerError(422, 'crypto.signature-invalid', `Invalid signature for key: ${key}`),
  hashInvalid: (hash: string) => new LedgerError(422, 'crypto.hash-invalid', `Invalid record hash: ${hash}`),
  unauthorized: () => new LedgerError(401, 'auth.unauthorized', 'Invalid token.'),
  forbidden: () => new LedgerError(403, 'auth.forbidden', 'Forbidden.'),
}
