# Findings

Behaviour of the reference ledger (Minka public sandbox, `https://ldg-stg.one/api/v2`,
service 2.45.5, SDK 2.45.1) established by recording it. Each entry says how it was
established. Newest first.

## 2026-09-26 — Access (scenarios access, access2, access3, access4)

- **Open ledgers are open.** A ledger rule `{action: any, record: any}` (what the CLI
  creates) grants every caller every action, including `spend` on any wallet and
  `issue` on any symbol: in `access`, signer B moved alice's money and issued A's
  symbol. Levels are additive, so record rules cannot restrict it.
- **Scope:** a ledger-level rule without `record` covers the ledger record only. With
  `{any, signer: A}` alone, A could not create a symbol (`access2`, `access3`); it takes
  `record: any`. `{action: read}` without `record` makes the ledger record readable,
  nothing else.
- **Gate:** a mutation needs `access` on the ledger from the ledger's rules. With
  `{create, record: intent}` open to all, B (no `access`) was still refused 403;
  A (who has `any` on the ledger) was not.
- **Registration is irrelevant:** registering A as a signer record changed nothing.
- **Claim permissions** (`access4`, B passes the gate, has nothing on A's wallet or
  symbol): `POST /intents` succeeds (201), the intent stays pending, and the expiry job
  rejects it with `core.intent-expired` / `Intent <handle> expired` — as the docs say.
  Not implemented yet (needs expiry, L7).
- **Signer annotation:** a proof whose key belongs to a signer record comes back with
  `signer: <handle>`.
- **Status policies** behave as documented: a proof outside the quorum is stored with
  no effect; a status no value allows is 422 `record.status-policy-violation`,
  `Cannot set wallet status to blocked. No values correspond to the target status.`
- **Circles** `$crc`, circle signers `$csn` (created with 200, client proof without
  `origin`, no `meta.status`), policies `$plc`.
- **Forbidden details** name the operation: `Cannot create symbol.`, `Cannot create
  wallet.`, `Cannot read intent.` — also when the ledger gate refused (access2, B
  without `access`). Reproduced as `Cannot <action> <record>.`
- **Token impersonation** (`access3` #7, docs: about-authentication): when the
  token's `kid` is the key of a **registered signer record**, `system.auth` adds a
  proof `{custom: {moment, status, bearer.<claim>…}, origin: "self-signed-token",
  signer: <handle>, issuer: <handle of iss>}` after the client proofs, and its key
  becomes a second owner. It is added even though the client signed the body itself
  (the docs say fully signed proofs skip impersonation — they are kept, but the extra
  proof still appears). With a token whose key is no signer record nothing is added:
  `access` #9 (A's token, B's registered proof) has none. Reproduced; token-only
  bodies and partial proofs follow the docs (not recorded).

## 2026-09-26 — Record lifecycle, signers, access check

Recorded with `conformance/scenarios/records.ts` (`fixtures/records.reference.jsonl`).

- **Update** is `PUT /<kind>/<id>` with the whole new data and `data.parent` = the
  current hash; `luid` travels in the body. The answer (200) keeps luid, `meta.status`
  and `owners`, sets a new `meta.moment`, and the ledger countersigns with
  `{luid, moment}` — no status. A stale parent → 422 `crypto.parent-hash-invalid`,
  `Hash verification failed, hashes don't match` (in the error reference, not in the
  spec's enum).
- **Status** changes by `POST /<kind>/<id>/proofs` with one proof whose `custom.status`
  is the new status, signed over the current hash. The record comes back (200) with the
  proof appended as sent (plus `origin`), **no server proof**, `meta.status` changed,
  `meta.moment` unchanged.
- **Changes**: `GET /<kind>/<id>/changes` is newest first with `page.total`; each item
  is the full record at that version with `meta.change` (1, 2, …), `meta.action`
  (`create` | `update`) and `meta.labels: null`. A status proof is a change of its own.
  `GET …/changes/<n>` returns one.
- **Drop**: `DELETE /wallets/<id>` with `{luid, hash, data: {parent}, meta.proofs}`
  (the SDK signs it with `custom.status: "dropped"`) → **204** with no body; the wallet
  is gone from reads and lists.
- **Server signers**: every ledger publishes `system`, `core`, `system.auth` and
  `system.dtc` as signer records (`$snr` luids), listed in that order after any
  user-created signers. Data `{handle, access: [{action: read}], format, public,
  secret: "{{ secret.<16 letters> }}"}` — the secret is a reference into a secret
  store. Each is self-signed (proof without `origin` or `signer`) and countersigned by
  `system`; `owners` is its own key.
- **Access check** `POST /<kind>/<id>/access/!check` with `data: {action}` answers a
  list (no `page`) of the rules that grant it, each wrapped `{hash: sha256(rule), data:
  rule, meta: {proofs: [system], moment}}`. For `read` on a wallet it listed the ledger
  rule and a server-level `{action: any, record: wallet}` — but **not** the wallet's own
  `{action: any, signer: {public: <caller>}}`, which confirms the documented rule that
  `signer` constraints apply to mutations only (reads are matched through `bearer`).
  We do not copy the sandbox's server-wide wallet grant: `divergences.json`.

## 2026-09-26 — L3 and the questions L1 left open

Recorded with `conformance/scenarios/l3.ts` (`fixtures/l3.reference.jsonl`, 41 exchanges).

**Credits never offset debits — the docs are wrong here.** `wallet-limits.md` says a
claim that takes a wallet below its limit passes if another claim in the same intent
brings it back. The reference rejects `[issue alice 100, transfer alice→bob 100]` with
`Amount -100 is less than minimum allowed amount 0`, and a swap between two wallets
at zero the same way. Debits are summed per wallet and checked against `minBalance`;
credits are checked separately against `maxBalance`.

**Reference bug: `maxBalance` is checked after commit.** An issue that would take bob
from 15010 above his `maxBalance` of 20000 gets `prepared` and `committed
"awaiting-clearance"`, then a proof `{reason: core.limit-exceeded, detail: "Amount 25010
is greater than maximum allowed amount 20000 …", status: "committed"}` — and stays
`committed` for good; the credit is never applied. We reject such an intent before
preparing (same reason and detail). Listed in `conformance/divergences.json`.

**Limits:** a `limit` claim resolves no entries and follows the issue-only trail
(`prepared`, `committed awaiting-clearance`, `system {coreId, cleared}`, `completed`).
`GET /wallets/{id}/limits` serves rows `{hash, data: {wallet, symbol, metric, amount},
luid: "$wbl.…", meta: {proofs: [system], moment}}` — unlike balances they are hashed
(sha256 of `data`) and signed. `minBalance` messages carry the actual limit:
`Amount -21000 is less than minimum allowed amount -20000 …`. Setting a limit re-saves
the wallet's existing available row (`parent: ""`, new moment, same amount).

**Resolution order:** per claim, source wallet, target wallet, then symbol — with an
unknown source and an unknown symbol the reference reports the wallet. Unknown source:
`Source wallet not resolved for the address ghost - does not resolve to any existing
wallet. Parent wallet: ghost`.

**Core participation:** an intent with any debit gets `core` prepared/cleared proofs for
*every* entry, including an issue's credit (`[issue eur, transfer usd]`).

**Lists and pages:** symbols, wallets and intents are all newest first. Pagination is
`?page.index=1&page.limit=2`, echoed as `page: {index, limit}`. Balances sort by symbol
then schema, not by creation. `GET /intents/<luid>` works like `GET /intents/<handle>`.

## 2026-09-26 — L1

Recorded with `conformance/scenarios/l1.ts`: issue, transfer, destroy, overdraw,
unknown wallet and symbol, a two-claim intent whose second claim fails, and schema
errors. Reference ledger answers in `conformance/fixtures/l1.reference.jsonl`.

**Reference bug: a ledger created without `config` cannot move money.** `POST /ledgers`
accepts a ledger without `config` (it is stored as `null`), but every intent on it then
stops at `committed` with `core.unexpected-error "Ledger failed to commit intent"` and
never completes; balances stay empty. The same scenario with
`config: {"intent.expiryThresholdMinutes": 60, "access.strategy": "record-based"}` (what
the official CLI always sends) works. Established by recording both. We do not
reproduce the failure; the scenario sends a config like the CLI.

**Intent lifecycle** (identical proof sequence in every recorded run):

- `POST /intents` → **201** with `meta.status: "pending"` and three proofs: the client's
  (`status: created`), `system {moment, status: pending}`, `system {luid, moment,
  status: pending}`. `meta` also has `thread` (a `-`-prefixed 17-character id),
  `domains: []`, `moment`, `owners`. Processing is **asynchronous**; the docs'
  contradiction between `created` and `pending` resolves to `pending`.
- Resolution: one `system` proof per entry, `{amount, handle: "deb_…"|"cre_…",
  inputs: [claim index], moment, schema: debit|credit, status: resolved, symbol,
  wallet}`; for each claim the debit comes before the credit. Issue has only a credit,
  destroy only a debit.
- Success: if the intent has any debit, a separate per-ledger **`core`** signer adds
  `{handle, moment, schema, status: prepared}` for every entry; then `system prepared`;
  `system committed "awaiting-clearance"`; then either one bare core proof per entry
  (`{detail: cleared, handle, moment, schema, status: committed}`, **no `signer`, no
  `origin`**) or, for an issue-only intent, `system {coreId: <intent handle>, detail:
  cleared, status: committed}`; finally `system completed`. `meta.routed: true` appears
  on completed intents only.
- Failure: `system {detail, moment, reason, status: failed}`, `system aborted`,
  `system rejected`. Resolution failures (unknown wallet or symbol) come before any
  resolved entry; limit failures come after them.

**Balances:**

- Rows per wallet × symbol × schema, `schema` ∈ `available`, `reserved`. Shape:
  `{hash: "", data: {wallet, symbol, schema, amount}, luid: "$wbl.…", meta: {moment}}` —
  unsigned. A debit reserves (available −, reserved +) and clearing releases the
  reservation, so after a debit a `reserved` row with amount 0 remains.
- A row touched by a reservation serialises with `data.parent: ""` from then on;
  credit-only rows do not have it. Reproduced.
- The balance list has `page.total`; order is creation order (available first).

**Limits:** available may not go below 0. The check sums the intent's debits per
wallet and ignores its credits: in a two-claim intent crediting bob 100 and debiting him
999999 from 2000, the reference reports `Amount -997999`. Error:
`core.limit-exceeded`, `Amount <after> is less than minimum allowed amount 0 for wallet
<w>, symbol <s>, schema available`. The docs name `core.insufficient-balance`; the
reference never used it.

**Other errors:** unknown target → `core.routing-failed`, `Target wallet not resolved for
the address ghost - does not resolve to any existing wallet. Parent wallet: ghost`;
unknown symbol → `core.symbol-invalid`, `Symbol eur not found.`; duplicate handle → 409
`record.duplicated` `Intent with handle i-issue already exists.`; zero amount → 422 with
Ajv's `oneOf` errors, one per claim branch (issue, transfer, destroy, limit).

**Lists:** `GET /intents` is newest first, without `page.total`.

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
