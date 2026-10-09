// Schemas a ledger's users define (`$sch` with `format: json-schema`), recorded in
// `uschema`. A record that names one in `data.schema` has its `data` validated against
// it (JSON Schema draft-07, every error); a record that names none is refused once any
// schema for its kind exists. Built-in validation runs first.
import { Ajv, type ErrorObject } from 'ajv'
import { LedgerError } from './errors.js'

const ajv = new Ajv({ allErrors: true, strict: false })
const compiled = new Map<string, ReturnType<typeof ajv.compile>>()

/** A schema's content must be a valid JSON Schema: `422 Schema content is invalid`. */
export function checkContent(schema: unknown) {
  if (ajv.validateSchema(schema as object)) return
  throw new LedgerError(422, 'record.schema-invalid', 'Schema content is invalid', {
    error: { message: `schema is invalid: ${ajv.errorsText(ajv.errors)}` },
  })
}

// Ajv's instance path `/custom/kind` reads `data.custom.kind` in the detail.
const where = (e: ErrorObject) => `data${e.instancePath.replace(/\//g, '.')}`

export function validateData(schema: unknown, data: unknown) {
  const key = JSON.stringify(schema)
  let validate = compiled.get(key)
  if (!validate) {
    validate = ajv.compile(schema as object)
    compiled.set(key, validate)
  }
  if (validate(data)) return
  const errors = validate.errors ?? []
  const detail = `Schema validator error: ${errors.map((e) => `${where(e)} ${e.message}`).join(', ')}`
  throw new LedgerError(422, 'record.schema-invalid', detail, {
    errors: errors.map(({ instancePath, schemaPath, keyword, params, message }) => ({ instancePath, schemaPath, keyword, params, message })),
  })
}

export const schemaRequired = (record: string) =>
  new LedgerError(422, 'record.schema-invalid', `There are schemas defined for record of type ${record}, you must specify at least one.`)

export const schemaNotFound = (handle: string, record: string) =>
  new LedgerError(422, 'record.relation-not-found', `Schema ${handle} not found for record of type ${record}.`)
