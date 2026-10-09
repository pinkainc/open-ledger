# Findings

Behaviour of the reference ledger (Minka public sandbox, `https://ldg-stg.one/api/v2`,
service 2.45.5 — 2.46.5 since the effects recording, 2.47.4 since `abort`; SDK 2.47.0) established by recording it. Each entry says how it was
established. Newest first.

## 2026-10-09 — Drop of bridges and policies

Recorded with `conformance/scenarios/drops.ts` on 2.47.4 (19 exchanges), reproduced.
`DELETE /bridges/{h}` and `DELETE /policies/{h}` (the SDK reads the record, then sends
the signed drop): 204, then a read is 404 `Bridge not found` / `Policy not found`. A
bridge that a wallet names: 422 `record.drop-rejected`, `Bridge used is in use by
wallets. Please remove it from the wallets first.` A system policy (`intent:status`)
may be dropped: 204.

## 2026-10-09 — User schemas

Recorded with `conformance/scenarios/uschema.ts` on 2.47.4 (35 exchanges). All
reproduced (`server/src/user-schemas.ts`). The first recording had two scenario bugs
(string claim addresses; an SDK `data()` update merges deeply, so `{type: object}`
changed nothing) and was redone.

- **The schema validates `data`**, not the record: a schema `{required: ['data']}` fails
  every wallet with `data must have required property 'data'`. (The docs' own example
  wraps the rules in `properties.data`; it would never pass.)
- Order on create **and update**: the named schema is looked up first, then the data is
  validated, and only a record that names none is checked for "schemas of its kind
  exist" (the reference's trace: `assertSchemaRecord` → `validate` → `assertSchemaCount`).
- Named schema missing, or of another kind: 422 `record.relation-not-found`,
  `Schema <h> not found for record of type <kind>.` (a bridge keeps its own wording,
  `Referenced Schema <h> not found.`).
- None named while one exists for the kind: 422 `record.schema-invalid`, `There are
  schemas defined for record of type <kind>, you must specify at least one.` The same
  for an update of a record created before the first schema. A schema for symbols does
  not affect wallets.
- Invalid data: 422 `record.schema-invalid`, `Schema validator error: <errors>`, every
  error (Ajv `allErrors`), each `data<path with dots> <message>`, joined by `, `;
  `custom.errors` carries Ajv's objects `{instancePath, schemaPath, keyword, params, message}`.
- Schema content that is not JSON Schema: 422 `record.schema-invalid`, `Schema content
  is invalid`, `custom.error.message: "schema is invalid: <ajv errorsText>"`. An unknown
  `format` (only `json-schema`) or `record` kind is refused by the request validator.
- A schema update applies to the next record.
- Intents are validated synchronously on `POST /intents` (422, no intent created).

## 2026-10-09 — Abort before the bridge confirms it (v2.47)

Recorded with `conformance/scenarios/abort.ts` on sandbox 2.47.4 (16 client exchanges, 8
bridge calls); `l5`, `l6` and `l7` re-recorded on 2.47.4 the same day. All reproduced.
Release notes v2.47.0: *"Fixes reserved balances staying held on aborted intents while
bridges have not confirmed the abort."*

- A local debit and a credit to bridge `bank`; the bank fails the credit's prepare and
  holds its `aborted` report back. The intent goes `failed` → `aborted`, and **in the
  same step** the core signs `aborted` for every entry (debit and credit) and alice's
  reservation returns to `available` (100/0 while the bridge has not answered).
- When the bank reports `aborted`, the intent goes `rejected` and nothing else changes:
  no second core abort, no balance move. Proof order is therefore `core:aborted ×N`,
  `bank:aborted`, `system:rejected` (2.46 had the bank's report first).
- A bridge that never confirms leaves the intent `aborted` forever, with the money
  already released.
- Abort calls to bridges now carry `meta.domains: []` (last key) when the core took
  part in the intent; a forward intent's abort (no core, `l7`) still has none. In
  2.46 no abort call carried it.
- Nothing else in `l5`, `l6`, `l7` changed between 2.46.5 and 2.47.4.

## 2026-10-02 — Effects: signals, webhooks, bridge effects, their deliveries

Recorded with `conformance/scenarios/effects.ts` (51 client exchanges, 21 calls to the
test bridge and its `/hooks/*` webhooks; sandbox 2.46.5). Two recordings: the first
used the trait the docs name and was refused. All reproduced.

- **The trait is `effects`, not `events`.** `register-effect.md` says a bridge needs the
  trait `events`; the reference refuses it: 422 `record.schema-invalid`, `…/traits/0 must
  be equal to one of the allowed values: debits, credits, statuses, anchors, domains,
  effects, ping`, then `must be object`, then `oneOf`. Enum errors list the allowed
  values after the message (Ajv's text plus `: a, b, …`).
- **Effect record** `$eff`, created like any record (`status: created`, `owners`). Errors:
  an unknown `signal` (enum of the spec's 54 values, in the spec's order); a webhook
  without `endpoint` (each `oneOf` branch reports its missing property, then `oneOf`);
  a duplicate handle (409 `Effect with handle … already exists.`). **An unknown bridge
  and a bridge without traits are accepted.** `GET /effects?data.signal=…` is 400
  `api.query-malformed`, `Unsupported filters: 'data.signal'`. `DELETE /effects/{id}`
  (signed, `data.parent`) → 204, then 404 `Effect not found`.
- **The event** is a ledger record `{hash, data: {handle: evt_<17>, signal, …}, meta:
  {proofs: [system {moment}]}}`, sent as the body of `POST <endpoint>` (webhook) or
  `POST {bridge server}/effects/{effect handle}` (bridge). **One event per occurrence,
  shared by every effect it reaches** (same `evt_` handle).
  - `wallet-created`: `{wallet}` as stored. `intent-created`: `{intent}` as stored
    (pending, three proofs, `domains: []`).
  - `intent-updated`: `{intent, parent}`, four per ledger-only transfer: prepared (parent:
    pending after resolution), committed awaiting-clearance (parent: prepared, `routed`),
    committed after the core's clearance proofs (parent: the commit), completed (parent:
    **the commit, not the clearance** — a race of the reference's stages, the same in
    both recordings). The resolution version raises nothing. Versions leave out `domains`.
  - `balance-received`: `{amount, wallet, symbol, intent}` per credited wallet, the
    intent at its commit (nine proofs, `routed`). Filters are dot paths on the event
    (`wallet.data.handle`, `symbol.data.handle`, `intent.data.handle`).
- **Deliveries** are `$evd` records like a bridge's, `data: {handle, bridge, effect,
  record, linked}`: a webhook has `bridge: null`; `record`/`linked` name what the event
  is about (`wallet`/`bob` for balance-received). `GET /effects/{id}/events[/{handle}]`,
  `…/events/retry` and the deprecated `…/activate` behave as for bridges; a delivery of
  another effect is 404 `Event delivery '…' not found on ledger '…'`.
  - 500 then 202: `failed`, `delivered`, replay 2. 501: `failed`, `cancelled
    delivery.permanent-failure`, replay 1; a retry by handle delivers it (replay 2).
  - **No `detail.body`** on the last failed attempt, unlike a bridge's call.
  - A bridge without traits gets the call (it answered 404: six attempts, then
    `retry-cap-exhausted`). **A bridge whose traits leave out `effects` gets nothing** —
    not even a delivery record.
  - **A bridge that does not exist**: a delivery with `bridge: "nope"`, `record`,
    `linked` and `output` null, ten attempts `failed delivery.unexpected-error {detail:
    {reason: core.unexpected-error, message: "Bridge nope not found"}}` (1 s × 1.2…),
    then `cancelled retry-cap-exhausted`, replay 11.
- Delivery lists of an effect come in event order, which races between effects and
  stages; the comparator orders them by what the event is about.

## 2026-10-02 — Bridge security, the retry cap, traits, activate

Recorded with `conformance/scenarios/secure.ts` (44 client exchanges, 39 bridge
calls). Four bridges on one tunnel; the test bridge logs the headers named in `seen`
and serves an OAuth2 token endpoint. All reproduced but one timing artefact.

- **Secrets.** A `secure` value must be a reference `{{ secret.<name> }}` (pattern
  `^\{\{ secret\.[A-Za-z]+[A-Za-z0-9]* \}\}$`); its value is sent once, in
  `meta.secret.<name>` of the create, as for signer factors (v2.38). The stored record
  keeps the reference and never shows the value; `meta.secret` is not kept.
  - A plain value: 422 `record.schema-invalid`, one Ajv error per `oneOf` branch:
    `…/secure/0/clientId` required (oauth2), `…/secure/0/value` pattern (header),
    `…/secure/0/public` required (generic), then `oneOf`.
  - A reference without its value: 422 `record.invalid`, `Record data has a secret
    reference to new secret 'missing' but no secret value was provided in
    'meta.secret.missing'` ("new": an update may keep an earlier one).
- **`header` rules** put the resolved value on every call (prepare, commit, status).
- **`oauth2`**: `POST tokenUrl`, `Authorization: Basic base64(clientId:clientSecret)`,
  `content-type: application/x-www-form-urlencoded`, body
  `grant_type=client_credentials&scope=<scope>`; each call then has `Authorization:
  Bearer <access_token>`. **The token is not cached**: seven token requests for eight
  calls, with `expires_in: 3600` (the docs promise caching for tokens living ≥ 60 s).
- **Retry cap**: six attempts (1 s × 1.2…), then `cancelled {reason:
  delivery.retry-cap-exhausted}`. **The last failed attempt carries `detail.body`**
  (`"{}"` for an empty answer) — the same rule explains the 501 case recorded in
  `events`. The intent gets `error core.bridge-unreachable "Request failed with status
  code 500"` and stays pending.
- **`POST /bridges/{id}/activate`** (deprecated) with `{maxAge: 0}` → 202, no body; the
  cancelled delivery was sent again (seventh attempt, `delivered`) and the intent
  completed.
- A delivery being attempted is **`running`** (replay 0, no proofs) — caught once in a
  list read right after the intent completed.
- **Traits**: a bridge with `traits: ['debits', {method: 'credits', filter: {amount:
  {$gte: 100}}}]` got no status notifications at all (no `statuses`), the prepare and
  commit of a 150 credit, nothing for a 5 credit (the ledger applied it itself), and
  its debits unfiltered.

## 2026-10-02 — L7: threads (forward intents), expiry of a thread, the size cap

Recorded with `conformance/scenarios/l7.ts` (service 2.46.5). One bridge `bank`, four
wallets forwarding (`forward` route) to a wallet that refuses the claim, to bank
accounts that fail, prepare, or never answer. Two earlier runs on the sandbox
(`…20261002153639202`, `…154800742`) were read directly as well; the first contained
a forward loop (see last point).

- **The thread commits as one.** The first intent's trail: … `system prepared`; the
  forward intent is created right after (as recorded in routes); the first intent then
  **waits with `meta.status: prepared`** until the forward intent is prepared, and
  only then goes `committed "awaiting-clearance"` → cleared → `completed`. The forward
  intent commits after it (its `committed` follows the first's).
- **The thread fails as one.** A forward intent refused at resolution (`No matching
  out route found for intent <forward>.`) or by its bridge (`Bridge(s) failed to
  process intent: bank`): the first intent gets the **same** `failed {reason, detail}`,
  then `aborted`, `core aborted` per entry (reservation released) and `rejected`. The
  forward intent goes its own way: `failed → aborted → [bridge aborted] → rejected`.
- A forward intent's debit is **not checked against the balance**: it prepares while
  the forwarding wallet is still empty (its credit is prepared, not committed). It has
  no core proofs and no reservation (as in routes); its bridged credit gets the usual
  prepare, commit and status calls.
- `meta.routed: true` appears on a waiting first intent. When the forward intent was
  refused at once it was absent in one recording and present in the next — a race
  between the reference's stages; we always set it while waiting.
- **A forward intent whose bridge never answers is never expired**, although the ledger
  has a one-minute threshold: after nine minutes the forward intent was still `pending`
  and the first intent `prepared` (its 5 USD reserved). The docs say an expired intent
  aborts its thread. Deliberate divergence: we expire it and the thread follows.
- **Thread size cap** (`core.thread-size-exceeded`, `Thread size exceeded the maximum of
  10`): two wallets forwarding to each other made **~5000 intents in nine minutes** —
  every one left `prepared` — until the loop was broken by changing their routes by
  hand. Only then did the reference fail the thread with that reason. The cap is checked
  after the fact. Deliberate divergence: we refuse the intent whose forward would make
  the eleventh, and the thread fails with the reference's reason and detail. Never
  record such a scenario again.
- Unsupported list filter (read directly): `GET /intents?data.origin=…` → **400**
  `api.query-malformed`, `Unsupported filters: 'data.origin'` (with a stack trace in
  `custom.trace`). Not reproduced yet: we filter on any field.

## 2026-09-26 — L8: bridge event deliveries

Recorded with `conformance/scenarios/events.ts` (23 client exchanges, 20 bridge calls).
Delivery tracking is **on** on the sandbox (the docs call it alpha, behind two flags).
All reproduced.

- **Every call to a bridge is a delivery** `$evd`: `{hash, data: {handle: <17
  characters>, bridge, effect: null, record: "intent", linked: <intent>}, luid, meta:
  {status, replay, moment, output, proofs}}`. `hash` is of `data`; `output` is exactly
  the body sent (signed entry, command, or the intent itself for a status PUT).
- **One `system` proof per attempt**: `delivered {detail: {httpStatus}}`; `failed
  {reason: delivery.target-rejected, detail: {httpStatus}}` — `detail.body` appeared
  only for 501 (`"{}"` for an empty answer); `replay` counts attempts; `meta.moment`
  follows the last proof. A 500 then 202: `failed, delivered`, replay 2.
- **501**: `failed` then `cancelled {reason: delivery.permanent-failure}` (no detail),
  replay 1, no more attempts. **The intent gets a `system` proof `{status: "error",
  reason: "core.bridge-unreachable", detail: "Request failed with status code 501"}`**
  and stays `pending`.
- `GET /bridges/{id}/events` — newest first by creation, the usual filters
  (`meta.status`, `$in`, `data.linked`); `GET …/events/{handle}` — the record itself;
  unknown: 404 `Event delivery '<h>' not found on ledger '<l>'`.
- `POST …/events/retry` (signed `{handle}` or `{maxAge}`) → **202, no body**. By handle
  it resends a cancelled delivery (proofs `failed, cancelled, delivered`, replay 2); the
  bridge's report then completed the intent. Unknown handle: 404 `Event '<h>' not found
  on ledger '<l>'`.

## 2026-09-26 — Addresses and wallet routes

Recorded with `conformance/scenarios/routes.ts` (62 client exchanges, 18 bridge calls;
bridge `hpb` owns wallet `hpb`). All reproduced.

- **Address resolution** follows the documented hierarchy: `account:1050000029@hpb` →
  `hpb` (the bridge is called), `tel:15261234578` → `tel`, `loan:42@hpb` → `loan@hpb`,
  and a source address `account:9@hpb` → `hpb` (debit on the bridge). An issue to
  `tel:888` credits `tel`. The resolved proof names the **wallet**; the bridge is sent
  the claim's **address** (`target: {handle: "account:1050000029@hpb"}`; through a
  credit route, still the claim's `tel:777`).
- **Unresolvable addresses**: `core.routing-failed`, `Target wallet not resolved for the
  address 41111339@zaba - does not resolve to any existing wallet. Parent wallet:
  41111339@zaba` — the "parent" is the whole address; same for `acct:1`.
- `GET /wallets/<address>` of a non-wallet address is 404 `Wallet not found` (no
  resolution on reads).
- **Routes are stored as sent** (`routes` in the wallet data; creating a route to a
  wallet that does not exist yet is accepted).
- `credit` → the credit lands on the route's target (resolved proof `wallet: alice`);
  `debit` → the debit comes from the route's target. `accept` with a filter refuses
  other claims: `No matching out route found for intent i-accept-usd.`; an input route
  that matches nothing: `No matching in route found for intent i-eur-out.`; a cycle:
  `Credit routing cycle detected for the address cyc1.` All `core.routing-failed`,
  before any resolved entry.
- `forward` credits the wallet, then the ledger makes **a new intent in the same
  thread**: handle of 17 characters (the entry-id alphabet), `data: {handle, claims:
  [transfer <wallet> → <route target>], origin: <first intent>}`, a bare `created` proof
  by `system`'s key, then `system` pending ×2; created after the first intent's
  `prepared`. Its trail has **no core proofs** although it debits (`system {coreId,
  cleared}` like an issue) and the wallet gets **no reserved row**.
- **Balance rows**: every recording fits one rule — a row that is updated (moved again
  after it was created, or touched by a reservation) carries `parent: ""`; a row only
  ever created by one credit has none (`tel`, credited twice, has it; `loan@hpb`, once,
  has not).

## 2026-09-26 — L6: several bridges in one intent

Recorded with `conformance/scenarios/l6.ts`: two bridges on one port behind one tunnel
(`bank1` without grouping; `bank2` with `debits.claims.groupBy: address`,
`credits.claims.groupBy: wallet`), 34 client exchanges and 75 bridge calls. All
reproduced.

- **Prepare runs in two phases.** Debit prepares go out first; credit prepares only once
  every debit part has reported `prepared` (`a1 → b2`: debit, bank1 prepared, then the
  credit to bank2). Without bridged debits the credits go at once. First-phase calls
  carry the intent as resolved (no `domains`); **second-phase credits carry the current
  intent** — core `prepared` proofs and the debit reports — with `meta.domains: []`.
- **A failed debit ends the intent before any credit is prepared**: the abort goes only
  to the debit, and only its bridge gets the final status (`PUT … rejected`); the credit's
  bridge hears nothing at all.
- **A failed credit after a prepared debit** aborts both (debit and credit, each on its
  bridge, arriving debit first — not in reverse). Aborts and commits behave as parallel.
- **Debit and credit on the same bridge** (`a1 → a1b`, both bank1): two separate
  entries, two prepares (debit, then credit after its report), two commits; one status
  notification per bridge.
- **Grouping** (`claims.groupBy`): resolution proofs stay one per claim. The bridge call
  for a group of two or more is a new entry with a handle of its own (`deb_…`/`cre_…`,
  not among the resolved ones), `amount` summed, `inputs` listing every claim, and `null`
  for the side it does not group (`target: null` on a grouped debit, `source: null` on a
  grouped credit). A group of one is the plain entry (its resolved handle, both sides).
  Reports, commits and aborts use the group's handle.
- **A bridge that accepts a prepare and never reports**: the intent waits and expires
  (one-minute threshold: failed `core.intent-expired` after 92 s), then abort to that
  part, bank aborted, core aborted per entry, rejected. No `prepared` notification.
- **A bridge that never reports `committed`**: the intent stays `committed` for good;
  the commit call (answered 202) is not repeated.
- **Racing reports**: proofs of several bridges land in the trail in arrival order; the
  comparator sorts adjacent same-status reports of external signers before comparing.

## 2026-09-26 — What the `minka` CLI needs (end to end, and the sandbox read directly)

Found by running `minka` 2.45.1 against our server (`scripts/cli-e2e.sh`), each answer
then read from the sandbox with curl.

- **`GET /api/v2`** (not in the spec): `minka server connect` refuses a server without it.
  The sandbox answers 200 `{hash, data: {handle: "stg", server: "https://ldg-stg.one/api/v2",
  semver: "2.45.7", status: "UP"}, meta: {moment}}` — hashed, unsigned; `/api/v2/` too.
- **`minka ledger create` sends no token**, only the signed body. The sandbox creates the
  ledger (the 2026-08 walkthrough did it the same way); we required a token until now.
- **Before every create** the CLI reads `GET /schemas?data.record=<kind>` and, for records
  with status policies, `GET /policies?data.record.$in[0]=any&data.record.$in[1]=<kind>`.
- **Every ledger has 12 schemas** (`$sch`), listed status, layout, access, labels,
  schedule, processing, authentication, dtc (policy), rest (bridge),
  oauth-client-credentials, key-pair, otp (signer-factor). Each is signed like the system
  policies (bare `system` proof, then `system {luid, moment}`), dated with the ledger, no
  status. `?data.record=symbol` → `[]` with the usual `page`.

## 2026-09-26 — L5: two-phase commit with a bridge

Recorded with `conformance/scenarios/l5.ts`: a bridge (`conformance/bridge.ts`) reached
by the sandbox through a cloudflared quick tunnel, recording every call it received
(`fixtures/l5.bridge.jsonl`, 24 lines) next to the client's exchanges (21). All
reproduced.

- **A bridge must name a schema.** Every ledger has one bridge schema, `rest`; without
  `schema` the create is 422 `record.schema-invalid`, `There are schemas defined for
  record of type bridge, you must specify at least one.` Every ledger has 12 system
  schemas (policy status/layout/access/labels/schedule/processing/authentication/dtc,
  bridge rest, signer-factor oauth-client-credentials/key-pair/otp) —
  `docs/reference-system-schemas.json`. A wallet naming a missing bridge: 
  `record.relation-not-found`, `Referenced Bridge bank not found.` (status per the
  error reference: 422).
- **Bridged wallets keep ledger balances.** `acc` (bridge `bank`) ended with native
  `available` 58 and a `reserved` row: the core prepares, reserves and clears every
  entry as for any wallet; the bridge takes part *in addition* for its entries.
- **Resolution** adds `bridge: <handle>` to the resolved proof of a bridged entry.
- **Only transfers call the bridge.** An issue to `acc` records `bridge` and completes
  like any issue, with no call.
- **Calls** (no auth headers with `secure: []`; axios, tracing headers only):
  prepare `POST {server}/credits|debits` with `{hash, data: {handle, luid: "$ben.…",
  schema, source, target, symbol, amount, inputs, intent}, meta: {proofs: [system
  {moment}]}}` — the intent as it was right after resolution (5 proofs, before the
  core's `prepared`), **without `meta.domains`**; commit/abort
  `POST {server}/<schema>s/<entry>/commit|abort` with `{handle, action, intent}`, the
  intent at `committed` (10 proofs, `routed`) or `aborted`; status
  `PUT {server}/intents/<handle>` with the intent itself, on `prepared` and on the final
  status (a rejected intent that never prepared gets only the final one). Every body is
  hashed and signed by `system` like a record.
- **Success trail:** resolved… → core prepared per entry → bank prepared → system
  prepared → system committed awaiting-clearance → (commit call) → core cleared per
  entry → bank committed → system completed.
- **Failure trail:** bank failed `{reason: bridge.…, detail}` → system failed
  `{reason: core.bridge-prepare-failed, detail: "Bridge(s) failed to process intent:
  bank"}` → system aborted → (abort call, also to the failing entry) → bank aborted →
  core aborted per entry (reservation released) → system rejected.
- **Retry:** a prepare answered 500 was sent again with the same body (`$ben` luid and
  hash) and accepted.
- **Reports** arrive as proofs on `POST /intents/{id}/proofs` from the bridge's key
  (a registered signer, so annotated `signer: bank`); no impersonation proof is added.

## 2026-09-26 — Operations confirmed by `records2`

Recorded with `conformance/scenarios/records2.ts` (52 exchanges, all reproduced).

- **Access check, corrected.** The check evaluates rules against the **proofs of the
  check request, for reads too**, and shows each granting rule **without `signer`**; a
  record-level rule without `record` is shown with the record's kind. Ledger rules come
  first, then the record's own; server rules were never listed. `{any, signer: A}` on
  a symbol comes back as `{any, record: symbol}`. This overturns the earlier reading of
  the `records` fixture (below): the `{action: any, record: wallet}` listed there was
  alice's own rule, not a sandbox server rule — the divergence is gone (23/23).
- **The ledger record** has the same lifecycle as other records: `PUT /ledger` (parent
  hash, countersigned `{luid, moment}`), `POST /ledger/proofs` for status,
  `GET /ledger/changes[/{n}]`, `POST /ledger/access/!check`.
- **Every ledger has two status policies** (`$plc`), listed after user policies:
  `intent:status` (record `intent`, quorum `[{handle: system}]`, statuses created …
  expired) and `access-policy:status` (record `policy`, `filter: {schema: access}`,
  statuses created/active/inactive, empty quorum). Each carries a bare self-proof by
  `system` (no `custom`), then `system {luid, moment}`; no `meta.status`; `meta.moment`
  is the ledger's.
- **Intent changes:** one per saved stage — create (pending, 3 proofs), resolved
  (pending), prepared, the same again with `meta.routed: true`, committed
  (awaiting-clearance), committed (cleared), completed: seven for an issue.
- **A further signature on an intent** (`POST /intents/{id}/proofs`, a proof without
  status) is appended with `origin: key-pair`; owners and status stay. An intent
  waiting for a `spend` signature was **not** processed again after the owner signed
  it (still pending 60 s later). What does restart it is open.
- Changes, updates and status proofs of symbols, signers, circles and policies behave
  like wallets'.

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
  rejects it with `core.intent-expired` / `Intent <handle> expired`. The trail: the
  `resolved` entries right away, nothing else (no `prepared`, no reservation), then
  `failed {reason, detail}`, `aborted`, `rejected` — final status `rejected`, not the
  `aborted` the docs (intent-expiry) describe. With a one-minute threshold the
  rejection came after 81 s and 118 s: the job runs periodically. Reproduced.
- **access4 fixture repaired:** the recording had 36 exchanges of a concurrent l0/l1
  run (other ledgers) mixed in through the shared proxy; they were removed.
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
  rule and `{action: any, record: wallet}`. *Read at the time as a sandbox server rule;
  it is the wallet's own rule with `signer` removed — see records2 above.*

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
