# Findings

Behaviour of the reference ledger (Minka public sandbox, `https://ldg-stg.one/api/v2`,
service 2.45.5, SDK 2.45.1) established by recording it. Each entry says how it was
established. Newest first.

## 2026-09-26 — L0

**Wire format** (verified on every recorded exchange with an independent script):

- Record `hash` = sha256(JCS(`data`)), hex. Proof `digest` = sha256(`hash` +
  JCS(`custom`)), hex. `result` = ed25519 over the digest bytes, base64. Keys are raw
  32-byte ed25519 in base64. Matches `/ledger/securing-the-ledger/hash-and-sign-requests`.
- List and error responses are envelopes `{hash, data, meta: {proofs, moment}}` whose
  `hash` is sha256(JCS(`data`)) as well — errors are signed too.
- A created record comes back with the client proofs tagged `origin: "key-pair"`, plus
  one server proof whose `custom` is `{luid, moment, status: "created"}` and which
  carries `signer: "system"`. `meta` gains `status`, `moment` and `owners` (the public
  keys of the client proofs).
- **Quirk:** a ledger created without `config` is stored and served with
  `config: null`, added after the client hashed the data, so the served `data` no
  longer hashes to the served `hash`. Reproduced.
- Record lists have `page: {index, limit}` without `total`; the balances list has
  `total`. Default limit is 20.
- Luids look like `$wlt.-2vcyddudkeQg6cbj` (prefix, dot, 17 characters from the
  `-0-9A-Z_a-z` alphabet). They grow with time but do not decode cleanly as a
  timestamp; treated as opaque.

**Signers:**

- **Every ledger has its own `system` signer**, created with the ledger. Two ledgers
  recorded a few minutes apart were signed by two different keys. Responses before a
  ledger is resolved (schema error on `POST /ledgers`, unknown ledger) carry
  `proofs: []`.
- The addressed ledger is resolved from `x-ledger` before any validation: a schema or
  token error inside an existing ledger is still signed by that ledger.

**Authentication and access:**

- Bearer tokens are EdDSA JWTs with the raw public key as `kid`. Claims the CLI sends:
  `iss: "cli"`, `sub: "signer:<handle>"`, `aud: <ledger handle>`, `exp: 3600` (the SDK
  adds it to `iat` — it is a lifetime, not an epoch).
- The SDK's default `createHsh: true` adds an `hsh` claim that binds the token to the
  absolute request URL. Through a proxy (different host) the sandbox rejects it with
  `401 auth.unauthorized "Invalid token."`; sent directly, the same token is accepted.
  Established by sending the same request both ways.
- A ledger with the rule `{action: "any", record: "any"}` (no signer, no bearer) can
  be **read with no token at all**. The rule grants to everyone.
- Mutations must carry proofs regardless of the token: an unsigned `POST /wallets` with
  a valid token is `422 crypto.signature-missing`.

**Error codes observed** (status, `reason`, `detail`):

| Case | Status | reason | detail |
| --- | --- | --- | --- |
| required property missing | 422 | `record.schema-invalid` | `Schema validation error: request/body/data must have required property 'handle'` |
| no proofs on a mutation | 422 | `crypto.signature-missing` | `Ledger mutations must be signed.` |
| proof signed by a different key | 422 | `crypto.signature-invalid` | `Invalid signature for key: <public>` |
| data changed after hashing | 422 | `crypto.hash-invalid` | `Invalid record hash: <hash>` |
| duplicate handle | 409 | `record.duplicated` | `Wallet with handle alice already exists.` |
| missing record | 404 | `record.not-found` | `Wallet not found` |
| unknown `x-ledger` | 404 | `api.route-not-found` | `Server does not host requested ledger` |
| malformed token | 401 | `auth.unauthorized` | `Invalid token.` |

**Reference internals visible from outside** (not part of the contract, recorded
because they explain behaviour): Express with `routing-controllers`; bodies are
validated by `express-openapi-validator` against the published OpenAPI spec; errors
carry a full stack trace in `data.custom.trace`, which is not reproduced.
