// Request body validation.
//
// The reference ledger validates bodies with express-openapi-validator (Ajv 8, first
// error per branch) and returns Ajv's errors verbatim in `custom.errors`, which
// clients can read. To produce the same errors these schemas mirror the structure of
// the published request schemas — the order of `allOf` parts and of `required` lists
// decides which error comes first. They are written here from observed behaviour and
// the documented field lists, not copied from Minka's spec.
import { Ajv, type ErrorObject } from 'ajv'
import { LedgerError } from './errors.js'

const ajv = new Ajv({ allErrors: false, strict: false })

const baseData = { type: 'object', required: ['handle'] }
const ref = { type: 'object', required: ['handle'], properties: { handle: { type: 'string' } } }
const amount = { type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991 }

const claims = {
  type: 'array',
  items: {
    oneOf: [
      {
        type: 'object',
        required: ['action', 'target', 'symbol', 'amount'],
        properties: { action: { const: 'issue' }, target: ref, symbol: ref, amount },
      },
      {
        type: 'object',
        required: ['action', 'source', 'target', 'symbol', 'amount'],
        properties: { action: { const: 'transfer' }, source: ref, target: ref, symbol: ref, amount },
      },
      {
        type: 'object',
        required: ['action', 'source', 'symbol', 'amount'],
        properties: { action: { const: 'destroy' }, source: ref, symbol: ref, amount },
      },
      {
        type: 'object',
        required: ['action', 'wallet', 'symbol', 'amount', 'metric'],
        properties: {
          action: { const: 'limit' },
          wallet: ref,
          symbol: ref,
          amount: { type: 'integer' },
          metric: { enum: ['minBalance', 'maxBalance', 'dailyAmount', 'dailyCount'] },
        },
      },
    ],
  },
}

// A bridge `secure` rule (spec: bridge-security-rule). Secret values are references
// `{{ secret.<name> }}`; the value itself travels once, in `meta.secret` (recorded,
// secure). With a plain value the reference reports one error per branch, in this
// order: oauth2's missing `clientId`, header's pattern, generic's missing `public`.
const secretRef = { type: 'string', pattern: '^\\{\\{ secret\\.[A-Za-z]+[A-Za-z0-9]* \\}\\}$' }
const securityRule = {
  oneOf: [
    {
      type: 'object',
      required: ['schema', 'clientId', 'tokenUrl', 'clientSecret'],
      properties: { schema: { type: 'string', enum: ['oauth2'] }, clientId: { type: 'string' }, tokenUrl: { type: 'string' }, clientSecret: secretRef, scope: { type: 'string' } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['schema', 'key', 'value'],
      properties: { schema: { type: 'string', enum: ['header'] }, key: { type: 'string' }, value: secretRef },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['schema', 'public', 'secret'],
      properties: { schema: { type: 'string' }, public: { type: 'string' }, secret: secretRef },
      additionalProperties: false,
    },
  ],
}

const DATA = {
  ledgers: { allOf: [{ type: 'object', required: ['handle', 'signer'] }, baseData] },
  symbols: { allOf: [{ type: 'object', required: ['factor'] }, baseData] },
  wallets: baseData,
  intents: { allOf: [{ type: 'object', required: ['handle', 'claims'], properties: { claims } }, baseData] },
  signers: baseData,
  circles: baseData,
  policies: { allOf: [{ type: 'object', required: ['handle', 'schema', 'values'] }, baseData] },
  schemas: { allOf: [{ type: 'object', required: ['record', 'format', 'schema'] }, baseData] },
  'circle-signers': { type: 'object', required: ['circle', 'signer'] },
  drop: { type: 'object', required: ['parent'] },
  bridges: {
    allOf: [
      {
        type: 'object',
        required: ['config', 'secure'],
        properties: { config: { type: 'object', required: ['server'], properties: { server: { type: 'string' } } }, secure: { type: 'array', items: securityRule } },
      },
      baseData,
    ],
  },
} as const

export type ValidatedKind = keyof typeof DATA

const validators = Object.fromEntries(
  Object.entries(DATA).map(([k, data]) => [
    k,
    ajv.compile({ type: 'object', allOf: [{ type: 'object' }, { type: 'object', required: ['data'], properties: { data } }] }),
  ]),
) as Record<ValidatedKind, ReturnType<typeof ajv.compile>>

// Ajv reports a missing property at its parent; the reference names the property in
// `path` but keeps the parent in the human-readable `detail`.
function toWire(e: ErrorObject) {
  const missing = e.keyword === 'required' ? `/${(e.params as any).missingProperty}` : ''
  return {
    path: `/body${e.instancePath}${missing}`,
    message: e.message ?? '',
    errorCode: `${e.keyword}.openapi.validation`,
  }
}

export function validateBody(kind: ValidatedKind, body: unknown) {
  const validate = validators[kind]
  if (validate(body ?? {})) return
  const errs = validate.errors ?? []
  const detail = `Schema validation error: ${errs.map((e) => `request/body${e.instancePath} ${e.message}`).join(', ')}`
  throw new LedgerError(422, 'record.schema-invalid', detail, { errors: errs.map(toWire) })
}
