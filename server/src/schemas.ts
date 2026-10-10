// Request body validation.
//
// The reference ledger validates bodies with express-openapi-validator (Ajv 8, first
// error per branch) and returns Ajv's errors verbatim in `custom.errors`, which
// clients can read. To produce the same errors these schemas mirror the structure of
// the published request schemas — the order of `allOf` parts and of `required` lists
// decides which error comes first. They are written here from observed behaviour and
// the documented field lists, not copied from Minka's spec.
import { Ajv, type ErrorObject } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { LedgerError } from './errors.js'

const ajv = new Ajv({ allErrors: false, strict: false })
// `unevaluatedProperties` (spec: every record's data) needs draft 2019-09.
const ajv2019 = new Ajv2019({ allErrors: false, strict: false })

// A record's `access` (spec: access, access-rule, access-policy), on every record kind.
// Recorded (bproofs): `sign` is no action, so a rule `{action: sign, record: intent}`
// (what about-intents asks for on a bridge) is refused, with this error list.
const accessActions = ['abort', 'access', 'activate', 'retry-event', 'any', 'assign-signer', 'commit', 'create', 'destroy', 'drop', 'issue', 'limit', 'lookup', 'manage', 'query', 'read', 'remove-signer', 'spend', 'update', 'reveal']
const accessRecords = ['anchor', 'anchor-proof', 'any', 'bridge', 'bridge-proof', 'circle', 'circle-proof', 'circle-signer', 'domain', 'domain-proof', 'effect', 'effect-proof', 'intent', 'intent-proof', 'ledger', 'ledger-proof', 'policy', 'policy-proof', 'report', 'report-proof', 'request', 'schema', 'schema-proof', 'server', 'signer', 'signer-proof', 'signer-factor', 'signer-factor-proof', 'signer-factor-secret', 'symbol', 'symbol-proof', 'wallet', 'wallet-proof']
const oneOfOrSet = (values: string[]) => ({
  oneOf: [
    { type: 'string', enum: values },
    {
      oneOf: [
        { type: 'object', properties: { $in: { type: 'array', items: { type: 'string', enum: values } } }, additionalProperties: false },
        { type: 'object', properties: { $nin: { type: 'array', items: { type: 'string', enum: values } } }, additionalProperties: false },
      ],
    },
  ],
})
const access = {
  type: 'array',
  items: {
    oneOf: [
      { type: 'object', required: ['action'], properties: { action: oneOfOrSet(accessActions), record: oneOfOrSet(accessRecords) } },
      {
        type: 'object',
        required: ['policy'],
        properties: { policy: { oneOf: [{ type: 'string' }, { type: 'object', properties: { $in: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }] } },
        additionalProperties: false,
      },
    ],
  },
}
const baseData = { type: 'object', required: ['handle'], properties: { access } }
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

// Spec `event-signal`, in its order: Ajv lists the allowed values as the enum has them.
export const SIGNALS = [
  'anchor-created', 'anchor-dropped', 'anchor-proofs-added', 'anchor-updated', 'balance-received', 'bridge-created',
  'bridge-entry-created', 'bridge-entry-proofs-added', 'bridge-entry-updated', 'bridge-proofs-added', 'bridge-updated',
  'circle-created', 'circle-proofs-added', 'circle-updated', 'domain-created', 'domain-proofs-added', 'domain-updated',
  'effect-created', 'effect-proofs-added', 'effect-updated', 'effect-dropped', 'intent-created', 'intent-proofs-added',
  'intent-updated', 'ledger-created', 'ledger-proofs-added', 'ledger-updated', 'policy-created', 'policy-proofs-added',
  'policy-updated', 'report-created', 'report-dropped', 'report-proofs-added', 'report-updated', 'request-created',
  'request-proofs-added', 'request-updated', 'schema-created', 'schema-proofs-added', 'schema-updated', 'signer-created',
  'signer-proofs-added', 'signer-updated', 'signer-factor-created', 'signer-factor-updated', 'signer-factor-proofs-added',
  'signer-factor-dropped', 'symbol-created', 'symbol-proofs-added', 'symbol-updated', 'wallet-created', 'wallet-limited',
  'wallet-proofs-added', 'wallet-updated',
] as const

// An effect's action (recorded, effects): with neither branch's field, each branch
// reports its missing property, then the oneOf.
const effectAction = {
  oneOf: [
    { type: 'object', required: ['schema', 'endpoint'], properties: { schema: { enum: ['webhook'] }, endpoint: { type: 'string' } } },
    { type: 'object', required: ['schema', 'bridge'], properties: { schema: { enum: ['bridge'] }, bridge: { type: 'string' } } },
  ],
}

// A bridge trait is a method name or an object naming one (recorded, effects: the
// names; `events`, which the docs give for effects, is not among them).
const trait = {
  oneOf: [{ enum: ['debits', 'credits', 'statuses', 'anchors', 'domains', 'effects', 'ping'] }, { type: 'object' }],
}

// A signer factor (spec: signer-factor-data, recorded in `factors`): one of three
// shapes, each closed. A key pair without `public` gets one error per branch: the
// generic shape's unevaluated `format`, the OAuth shape's schema enum, the key pair's
// missing `public`, then the anyOf.
const baseFields = { handle: {}, parent: {}, access: {}, custom: {} }
const factorData = {
  anyOf: [
    { allOf: [{ type: 'object', required: ['signer'], properties: { signer: { type: 'string' }, schema: { type: 'string' } } }, { type: 'object', properties: baseFields, required: ['handle'] }], unevaluatedProperties: false },
    {
      allOf: [
        { type: 'object', required: ['schema', 'signer'], properties: { signer: { type: 'string' }, schema: { type: 'string', enum: ['oauth-client-credentials'] }, clientId: { type: 'string' }, clientSecret: { type: 'string' } } },
        { type: 'object', properties: baseFields, required: ['handle'] },
      ],
      unevaluatedProperties: false,
    },
    {
      allOf: [
        { type: 'object', required: ['schema', 'signer', 'format', 'public'], properties: { signer: { type: 'string' }, schema: { type: 'string', enum: ['key-pair'] }, format: { type: 'string' }, public: { type: 'string' }, secret: { type: 'string' } } },
        { type: 'object', properties: baseFields, required: ['handle'] },
      ],
      unevaluatedProperties: false,
    },
  ],
}

// A body's hash, when it has one (recorded, oauth: an empty hash is a schema error).
const hash = { type: 'string', pattern: '^[A-Fa-f0-9]{64}$' }

const DATA = {
  ledgers: { allOf: [{ type: 'object', required: ['handle', 'signer'] }, baseData] },
  symbols: { allOf: [{ type: 'object', required: ['factor'] }, baseData] },
  wallets: baseData,
  intents: { allOf: [{ type: 'object', required: ['handle', 'claims'], properties: { claims } }, baseData] },
  signers: baseData,
  circles: baseData,
  policies: { allOf: [{ type: 'object', required: ['handle', 'schema', 'values'] }, baseData] },
  // Recorded (uschema): an unknown format or record kind is refused by the validator.
  schemas: {
    allOf: [
      {
        type: 'object',
        required: ['record', 'format', 'schema'],
        properties: {
          format: { enum: ['json-schema'] },
          record: { enum: ['anchor', 'anchor-lookup', 'bridge', 'circle', 'domain', 'effect', 'intent', 'policy', 'report', 'signer', 'signer-factor', 'symbol', 'wallet'] },
          schema: { type: 'object' },
        },
      },
      baseData,
    ],
  },
  'circle-signers': { type: 'object', required: ['circle', 'signer'] },
  drop: { type: 'object', required: ['parent'] },
  bridges: {
    allOf: [
      {
        type: 'object',
        required: ['config', 'secure'],
        properties: {
          config: { type: 'object', required: ['server'], properties: { server: { type: 'string' } } },
          secure: { type: 'array', items: securityRule },
          traits: { type: 'array', items: trait },
        },
      },
      baseData,
    ],
  },
  // Recorded (anchors): `target` required, nothing outside the documented fields.
  anchors: {
    allOf: [
      { type: 'object', required: ['target'], properties: { handle: {}, parent: {}, access: {}, custom: {}, schema: {}, wallet: {}, symbol: {}, source: {}, target: {}, amount: {} } },
      baseData,
    ],
    unevaluatedProperties: false,
  },
  domains: { allOf: [{ type: 'object', properties: { handle: {}, parent: {}, access: {}, custom: {}, schema: {} } }, baseData], unevaluatedProperties: false },
  effects: { allOf: [{ type: 'object', required: ['signal', 'action'], properties: { signal: { enum: SIGNALS }, action: effectAction } }, baseData] },
  factors: factorData,
  // Recorded (reports): `schema` is required whether or not a report schema exists.
  reports: { allOf: [{ type: 'object', required: ['schema'], properties: { schema: { type: 'string' } } }, baseData] },
} as const

export type ValidatedKind = keyof typeof DATA

const validators = Object.fromEntries(
  Object.entries(DATA).map(([k, data]) => [
    k,
    (JSON.stringify(data).includes('unevaluatedProperties') ? ajv2019 : ajv).compile({ type: 'object', allOf: [{ type: 'object', properties: { hash } }, { type: 'object', required: ['data'], properties: { data } }] }),
  ]),
) as Record<ValidatedKind, ReturnType<typeof ajv.compile>>

// Ajv reports a missing property at its parent; the reference names the property in
// `path` but keeps the parent in the human-readable `detail`.
// An enum error names the allowed values after the message (recorded, effects).
const messageOf = (e: ErrorObject) => (e.keyword === 'enum' ? `${e.message}: ${(e.params as any).allowedValues.join(', ')}` : (e.message ?? ''))

function toWire(e: ErrorObject) {
  // Recorded (secure2): an unexpected property is named in `path` too.
  const missing = e.keyword === 'required' ? `/${(e.params as any).missingProperty}` : e.keyword === 'additionalProperties' ? `/${(e.params as any).additionalProperty}` : ''
  return {
    path: `/body${e.instancePath}${missing}`,
    message: messageOf(e),
    errorCode: `${e.keyword}.openapi.validation`,
  }
}

// A report proof's status is one of the report statuses (recorded, reports).
const reportProof = ajv.compile({
  type: 'object',
  properties: { custom: { type: 'object', properties: { status: { enum: ['created', 'pending', 'completed', 'rejected', 'settled'] } } } },
})

// Recorded (ledgers): a ledger drop names the ledger's luid besides `data.parent`.
const ledgerDrop = ajv.compile({ type: 'object', required: ['luid', 'data'], properties: { hash, data: DATA.drop } })
export const validateLedgerDrop = (body: unknown) => check(ledgerDrop, body)

export const validateReportProof = (body: unknown) => check(reportProof, body)

export const validateBody = (kind: ValidatedKind, body: unknown) => check(validators[kind], body)

function check(validate: ReturnType<typeof ajv.compile>, body: unknown) {
  if (validate(body ?? {})) return
  const errs = validate.errors ?? []
  const detail = `Schema validation error: ${errs.map((e) => `request/body${e.instancePath} ${messageOf(e)}`).join(', ')}`
  throw new LedgerError(422, 'record.schema-invalid', detail, { errors: errs.map(toWire) })
}

// A processing policy's values (spec: aspect-processing-value; recorded, forwarding).
// The reference checks the whole policy against `policy-data`, an anyOf of every
// policy schema, so a bad value comes back inside the errors of the other branches:
// fixed ones before and after the processing branch's first error. A strategy an
// action may not use passes the schema and is refused after it.
export const ASPECT_ACTIONS = ['read', 'query', 'create', 'update', 'drop', 'sign'] as const
export const STRATEGIES = ['proxy', 'fallback', 'validate', 'synchronize'] as const
const aspectValue = ajv.compile({
  type: 'object',
  required: ['schema', 'action', 'invoke'],
  properties: {
    schema: { type: 'string', enum: ['aspect'] },
    action: { type: 'string', enum: ASPECT_ACTIONS },
    invoke: { type: 'object', required: ['bridge'], properties: { bridge: { type: 'string' } } },
    config: { type: 'object', required: ['strategy'], properties: { strategy: { type: 'string', enum: STRATEGIES } } },
  },
})
type Wire = { path: string; message: string; errorCode: string }
const wire = (path: string, message: string, keyword: string): Wire => ({ path: `/body/data${path}`, message, errorCode: `${keyword}.openapi.validation` })
// The branches of `policy-data` in the order the reference reports them; a policy that
// fails its own branch shows that branch's errors in place of its `schema` enum error.
const BRANCHES = ['layout', 'status', 'labels', 'access', 'aspect', 'processing', 'authentication', 'dtc'] as const
function policyInvalid(branch: (typeof BRANCHES)[number], own: Wire[]): LedgerError {
  const list: Wire[] = []
  for (const b of BRANCHES) {
    if (b === branch) list.push(...own)
    else if (b === 'aspect') list.push(wire('/action', "must have required property 'action'", 'required'))
    else list.push(wire('/schema', `must be equal to one of the allowed values: ${b}`, 'enum'))
  }
  list.push(wire('/schema', 'must match pattern "^(?!layout|access|status|labels|schedule|processing|authentication|dtc).*$"', 'pattern'), wire('', 'must match a schema in anyOf', 'anyOf'))
  // The detail names a missing property at its parent, like `check` above.
  const human = (w: Wire) => `request${w.errorCode.startsWith('required') ? w.path.replace(/\/[^/]+$/, '') : w.path} ${w.message}`
  return new LedgerError(422, 'record.schema-invalid', `Schema validation error: ${list.map(human).join(', ')}`, { errors: list })
}

const ACCESS_ACTIONS = ['abort', 'access', 'activate', 'retry-event', 'any', 'assign-signer', 'commit', 'create', 'destroy', 'drop', 'issue', 'limit', 'lookup', 'manage', 'query', 'read', 'remove-signer', 'spend', 'update', 'reveal']

/**
 * Values of status and access policies (recorded, reports3 and policies3): a status
 * value needs `quorum`; an access value's `action` is one string (an array is refused
 * with the errors of every `action` alternative).
 */
export function validatePolicyValues(data: any) {
  const values: any[] = Array.isArray(data?.values) ? data.values : []
  values.forEach((v, i) => {
    if (data.schema === 'status' && v && typeof v === 'object' && !('quorum' in v))
      throw policyInvalid('status', [wire(`/values/${i}/quorum`, "must have required property 'quorum'", 'required')])
    if (data.schema === 'access' && v && typeof v === 'object' && 'action' in v && typeof v.action !== 'string') {
      const at = `/values/${i}/action`
      throw policyInvalid('access', [
        wire(at, 'must be string', 'type'),
        wire(at, `must be equal to one of the allowed values: ${ACCESS_ACTIONS.join(', ')}`, 'enum'),
        wire(at, 'must be object', 'type'),
        wire(at, 'must be object', 'type'),
        wire(at, 'must match exactly one schema in oneOf', 'oneOf'),
        wire(at, 'must match exactly one schema in oneOf', 'oneOf'),
      ])
    }
  })
}

export function validateProcessing(data: any) {
  const values: unknown[] = Array.isArray(data?.values) ? data.values : []
  values.forEach((v, i) => {
    if (aspectValue(v)) return
    throw policyInvalid('processing', [toWire({ ...aspectValue.errors![0], instancePath: `/data/values/${i}${aspectValue.errors![0].instancePath}` })])
  })
  for (const v of values as any[]) {
    const strategy = v.config?.strategy
    const reading = v.action === 'read' || v.action === 'query'
    if (strategy === 'validate' && reading) throw new LedgerError(422, 'record.schema-invalid', "Cannot define 'validate' strategy for read or query actions")
    if (strategy === 'fallback' && !reading) throw new LedgerError(422, 'record.schema-invalid', "Cannot define 'fallback' strategy for non-read or query actions")
  }
}
