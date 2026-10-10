# Findings

Behaviour of the reference ledger (Minka public sandbox, `https://ldg-stg.one/api/v2`,
service 2.45.5 — 2.46.5 since the effects recording, 2.47.4 since `abort`, also for reports; SDK 2.47.0) established by recording it. Each entry says how it was
established. Newest first.

## 2026-10-10 — Route depth, route targets, anchor calls to bridges (routes2)

Recorded with `routes2` (47 exchanges, 5 bridge calls; one recording) on 2.47.4. Every
route resolves inside one intent; nothing forwards.

- **Credit routes chain three hops** (`e1 → e2 → e3 → end` completes); a fourth fails
  the intent `core.routing-failed` `Max wallet routing depth reached for intent
  i-depth4. Original source wallet: "alice", original target wallet: "d1".`
- A debit route cycle: `Debit routing cycle detected for the address dc1.` A route to
  an address that resolves to nothing: `Credit routed wallet not resolved for the address
  nothing-here - does not resolve to any existing wallet. Parent wallet: lost` — the
  wallet whose route it is.
- **A bridge's `secure` rules apply to the anchor and domain calls** (`GET
  …/wallets/<w>/anchors|domains`, `POST …/anchors/!lookup`): `x-api-key` from a header
  rule arrives beside the client's own `authorization`.
- **The bridge's list is not verified**: a wrong signature, or a hash of zeros, is
  accepted and the data listed.
- **A lookup on a wallet without a bridge finds nothing** (`[]`), though the wallet
  has anchors matching the lookup.
- A wallet with anchors cannot be dropped while `anchor.walletRequired` is off either.
  `custom.anchors` is ordered by luid: oldest first in `anchors`, newest first here.
  The reference's luids are time-prefixed but random within a second, so we sort by
  ours, and the comparison treats the list as a set.

## 2026-10-10 — Access inherited through domains

Recorded with `domains2` (43 exchanges, one recording) on 2.47.4, on a ledger that is
not open: the operator may change everything and reads through a bearer rule, everyone
may enter. Domain `a` grants key A everything (and a bearer read), its subdomain `c@a`
grants C everything, `b` grants B wallets. Records carry no rules of their own.

- **A domain's rules count for the records in it and in every subdomain below it**: A
  creates and updates wallets in `a` and `c@a`; C only in `c@a` (not upward); B wallets
  in `b` but not a symbol `eur@b` (`record: wallet`). A creation is judged by the domain
  the record joins; without one (`root-a`, and `wc@c@a`, which joins none — two `@`) the
  ledger's rules decide: 403 `Cannot create wallet.`
- **Domain records inherit nothing**: A cannot create `d@a`, C cannot create `e@a`.
- **In a domain, a signer rule also grants reads** to the token's key: C, with only `{any,
  record: any, signer: C}` on `c@a`, reads `wc3`; on a ledger or record, a signer rule
  never grants a read.
- **A list leaves out what the caller may not read** (first recording of it): A lists
  the wallets of `a` and `c@a`, C those of `c@a`, the operator all six.
- An intent joins the domain its proof names: `meta.domain: a` after `owners`.

## 2026-10-10 — Anchor forwarding by processing policies

Recorded with `forwarding` (third recording kept: 66 client exchanges, 29 bridge calls)
on 2.47.4. The bridge `dir` is a small alias directory in the scenario; it echoes what it
is sent, appends its proof, and misbehaves for chosen handles. Built in S5 continued
(`server/src/forwarding.ts`): 65/67 + 29/30, the rest is the synchronize `sign` bug below
(divergences.json). Not recorded, decided: without `config.strategy` reads fall back and
writes validate (the docs); `synchronize` on drop means validate, on query fallback; a
fallback list asks the bridge only when the ledger's own (filtered) list is empty; a
policy's `filter` is not applied yet.

**Policy** (`schema: processing`, `record: anchor`, `values` of `{schema: aspect,
action, invoke: {bridge}, config: {strategy}}`):
- In force whatever its status (`created` forwards). Several values for one action, in
  one policy or across policies, fail **at use**: 500 `forward.unexpected-error`
  `Multiple processing aspect values found for action read.` — not "first match wins".
- Refused at creation, 422 `record.schema-invalid`: read/query with `validate` (`Cannot
  define 'validate' strategy for read or query actions`), a write with `fallback`
  (`Cannot define 'fallback' strategy for non-read or query actions`), both with no
  `custom.errors`; an unknown strategy or action, or no `invoke`, fail the spec's
  `policy-data` anyOf: the list is the same ten errors each time (enum layout, status,
  labels, access; schedule's `/body/data/action` required; the processing branch's
  first error; enum authentication, dtc; the generic pattern; anyOf).
- Accepted: `synchronize` for drop and query, an `invoke.bridge` that does not exist
  (500 `Forward bridge 'ghost' configured but not exists` at use).
- The SDK's `policy.from(p).data({values})` merges arrays by index: a shorter list
  keeps the old tail.

**Calls to the bridge:** `{config.server}/v2/anchors[/{handle}[/proofs]]` — note the
`/v2`, unlike entries. `authorization` is the ledger's JWT (`iss: ledger:<ledger>`,
`sub: system@<ledger>`, `aud: <bridge>`, 24 h); the client's token moves to
`x-forwarded-authorization`. Reads by handle, the list without query string.
- create (every strategy): the client's record with a `luid` the ledger assigns and the
  ledger's proof `{moment, status: created}` (signer `system`, no luid) appended — the
  docs say `forwarded`, it is `created`. update: same, proof `{moment}`; drop: body
  `{data: {parent}, luid, meta}`, proofs `status: dropped`; sign: the client's proof only.
- synchronize create: the record is persisted first (meta with status, moment, owners,
  the local `created` proof with luid), then sent with one more `created` proof.
- validate: the luid sent with a create is **not** the one the local record gets (a
  second luid is drawn when it is persisted); later calls use the local one.

**Answers to the client:**
- proxy: the bridge's answer verbatim (its luid, its proofs; no ledger proof). A read of
  a record that exists only locally still goes to the bridge.
- validate: the local record; fallback: local when it exists, else the bridge's; a
  duplicate is refused locally (409 `record.duplicated` `Anchor with handle loc-1
  already exists.`) with no call.
- A signed bridge error keeps its status, reason, detail and custom; meta is the
  bridge's proof, then the ledger's with `custom.causedBy.detail: "Error derived from
  anchor forwarding response"`, and `meta.moment`. Nothing is persisted.
- No record in the answer: 502 `forward.invalid-response` `Invalid response from bridge
  dir`; a wrong hash: 422 `crypto.hash-invalid` `Invalid dto hash: <hash>` (docs: 502);
  a 401: 500 `forward.unexpected-error` `Unexpected error while forwarding request to
  bridge`; a list item without `hash`: 422 `Invalid dto hash: undefined`. Data the
  bridge changed breaks the client's proof: 422 `crypto.signature-invalid`, also on a
  later fallback read of it.
- synchronize `sign` answered 500 `api.unexpected-error` (a reference bug, not copied).

## 2026-10-10 — Who may report on a bridge's entry

Recorded with `bproofs` (45 exchanges, 20 bridge calls; three recordings, the last
kept) on 2.47.4, on a ledger that is not open (`{any, record: any}` for the operator
only, `access` and `read` for everyone). The bridge never reported by itself; the
scenario sent its `prepared` from different keys, one intent each.

- **Adding a proof to an intent is `create` on record `intent-proof`**, decided by the
  ledger's rules (the trace names `assertAccessToCreateProof`). `{create, record:
  intent-proof}` or `{any, record: intent-proof}` for the bridge's key lets its report
  through; `{any, record: intent}` on the ledger, `{any}` or `{any, record:
  intent-proof}` on the bridge record, and `{any}` on the bridged wallet do not.
- **The rule the docs ask for cannot be written.** about-intents: "the signer ... must
  have granted action sign for record intent on the bridge record". `sign` is no access
  action: `{action: sign}` in any record's `access` is 422 `record.schema-invalid`
  listing the action enum, both aggregation shapes and the `policy` branch. Every
  record's `access` is validated against the spec this way (ours since now too).
- **Any key that may add a proof may report an entry.** The operator's `prepared` on
  the bridge's credit entry committed the intent (commit call to the bridge); nothing
  checks that the reporter is the bridge. A registered signer and a stranger are
  refused like anyone without the right.
- The refusal is 403 `Missing permissions` with `custom.errors`: one `Cannot find
  required signer.` per rule that matches action and record but not the signer, plus
  two always (3 with only the operator's rule, 5 with two more for the bridge's key).

## 2026-10-10 — Generic `secure` rules (mtls)

Recorded with `secure2` (23 exchanges, no bridge call reached the tunnel) on 2.47.4,
twice: with a secret that is no key, then with a valid self-signed certificate and key.

- **A generic rule is validated** (`{schema, public, secret}`, `secret` a secret
  reference, nothing else): a plain secret, a missing `public`, an extra field are
  `record.schema-invalid` listing every `oneOf` branch; an unexpected property is
  named in `path` (`/body/data/secure/0/ca`). A reference without `meta.secret` is
  `record.invalid`, as for header rules.
- **The reference cannot call a bridge with a generic rule**, `mtls` included, valid
  key or not. Nothing is sent; each attempt fails `delivery.unexpected-error` with no
  detail, six times, then `cancelled delivery.retry-cap-exhausted`; the intent stays
  `pending`, noted `core.bridge-unreachable` `No handler found for security rule
  schema 'mtls' in bridge 'mt' (rule #0)`.
- Ours does the same for a schema it does not know and for mtls over plain http, and
  presents the certificate and key on https (deliberate, `divergences.json`).

## 2026-10-10 — Schema `extend`; list order

Recorded with `uschema2` (28 exchanges) on 2.47.4 (`server/test/uschema.test.ts`).

- **`extend` is stored and never applied**, against the spec ("inherit and extend")
  and the SDK ("inherit all rules and constraints"). A wallet under a child schema
  passes without what the parent requires, along a chain too, and when `extend` is
  added by update. Any parent is accepted: an unknown handle, a schema of another
  record kind, the schema itself. A cycle was not recorded (it could loop the
  reference); ours is harmless since nothing follows `extend`.
- **Lists are ordered newest change first** (`meta.moment` descending): an updated
  schema moves to the top. A ledger's system records share one moment, and two
  recordings list those ties in different orders, so a scenario lists filtered
  (`data.record=wallet`) where a tie would show.

## 2026-10-10 — The ledger collection, ledger drop, the journal

Recorded with `ledgers` (43 exchanges) on 2.47.4, reproduced
(`server/test/ledgers.test.ts`, `server/src/journal.ts`).

- **`GET /ledgers` lists the ledgers the caller owns** (signed their creation), newest
  first, filtered and paged like any list. A token of a key that owns none gets `[]`,
  even for a ledger with `{any, record: any}`; no token is 403 `Cannot query ledger.`;
  an `x-ledger` header is 422 `api.no-tenant-allowed`. The sandbox holds every ledger
  ever made, so the scenario tags its ledgers with `custom.run` and lists by it.
- **Ledger drop is switched off on the sandbox.** `DELETE /ledger` (the SDK's
  `ledger.drop()`) resolves the ledger (`Active ledger is not set!` without
  `x-ledger`), validates the body — `luid` is required besides `data.parent` — and
  then answers 404 `Route not found`, signed by the ledger, whoever signs and whatever
  the parent. `POST /ledger` is not routed at all: Express's HTML `Cannot POST
  /v2/ledger`. The ledger stays readable.
- **Journaling is switched off on the sandbox**: `GET /system/requests[/{id}]` is 404
  `Journaling is not enabled` for anyone, after the ledger is resolved. What an entry
  holds comes from the spec example and the SDK types only.
- **A list is the `query` action, decided by the ledger gate.** On a ledger whose only
  rule is `{any, signer: K}` (no `record`), K may not create a wallet (`Cannot create
  wallet.`) but lists wallets (200); a stranger is refused `Cannot query wallet.`
- **A duplicate ledger is refused under a fresh key**: the 409 is signed by `system`
  with a key that appears nowhere else — the new ledger's key, made before the handle
  was found taken.

## 2026-10-10 — Reports: the reporting protocol, statuses, assets

Recorded with `reports` (54 exchanges + 14 bridge calls, through a tunnel) and
`reports2` (243, client proofs only) on 2.47.4, reproduced
(`server/test/reports.test.ts`, `server/src/reports.ts`).

- **A report (`$rep`) needs `data.schema`**, also when no report schema exists
  (`request/body/data must have required property 'schema'`). An unknown schema, or
  one for another record: `record.relation-not-found` `Schema X not found for record of
  type report.` `custom` is validated by the schema like any user schema.
- **The protocol is the generic effect one.** No special trait: the docs' `reports`
  trait is refused by the bridge schema (the enum is debits, credits, statuses,
  anchors, domains, effects, ping). An effect on `report-created` (filter
  `report.data.schema`) with a bridge action posts `{handle, signal, report}` to the
  bridge's `/effects/{effect}` (trait `effects`). The bridge signs proofs on the
  report (`POST /reports/{id}/proofs`) over the unchanged hash; the ledger does not
  countersign them. The tutorial's `preparing` is `pending` in its own code.
- **Creating a report also raises `report-proofs-added`**, carrying the ledger's own
  `created` proof. Every stored proof raises one more.
- **Status table** (all 25 pairs recorded): created → pending | rejected; pending →
  completed | rejected; completed → settled; rejected → pending | completed (a
  retry); settled → nothing. Anything else: 422 `record.update-rejected` `Proof
  contains invalid status change, from X to Y`. A proof repeating the current status
  is answered 200 and **dropped**: not stored, no change, no event. An unknown status
  is a schema error listing the five. The docs' "rejected at any stage before
  completion" is wrong: completed → rejected is refused.
- **Assets** are set from a `completed` proof's `custom.assets` into `meta.assets` (an
  empty list too; none without the field). Each `output` must be
  `gs://{reporting bucket}/ledgers/{ledger}/schemas/{schema}/reports/{luid}/assets/{file}`
  with `file` = the asset handle. The sandbox's bucket is `ledger-reports-stg`. A bad
  asset is a **500** whose stack trace names the reason (`Invalid gs URL`, `bucket (…)
  different than reporting bucket`, `filename (…) different than asset handle`); the
  proof is not stored, the report stays `pending`. Assets on a `pending` proof stay in
  the proof only. We answer 422 `record.invalid` (divergences.json).
- **`GET /reports/{id}/assets/{asset}`** (the SDK's `downloadAsset`, not in the spec)
  streams the file from the reference's GCS bucket. Unknown asset or a report without
  assets: 500 (`Cannot read properties of undefined`). An accepted asset whose file is
  not in the bucket **drops the connection** (503 from the gateway, twice): do not
  record that again. Unknown report: 404 `Report not found`. We serve files from
  `OPEN_LEDGER_REPORTS_DIR` and answer 404 otherwise.
- Reports have no `PUT` (spec): data never changes after creation. Drop by `DELETE`
  and by `POST …/drop` (204, then 404). Lists filter by `meta.status` and
  `data.schema`. The CLI's `report create/list/show/sign/changes/drop` work against us
  (`scripts/cli-e2e.sh`).
- Not recorded `(?)`: whether the ledger and luid inside an asset path are checked
  (we check the shape), a report in a domain (`/domains/{d}/` in the path), status
  policies on reports, `report-dropped`.

## 2026-10-10 — Authentication: signer factors, OAuth tokens, `hsh`

Recorded with `factors` (43 exchanges), `oauth` (21) and `hsh` (18) on 2.47.4,
reproduced (`server/test/factors.test.ts`).

- **Factors are records** (`$snf`) under `/signers/{signer}/factors`, with the generic
  lifecycle: update by parent hash, proofs, access check (`record: signer-factor`),
  changes, drop. The system schemas `key-pair`, `oauth-client-credentials`, `otp`
  decide `schema`: none is `record.schema-invalid` (`There are schemas defined for
  record of type signer-factor…`), an unknown one `record.relation-not-found`. A key
  pair without `public` gets the three-branch anyOf error of the spec.
- A path naming another signer than the factor's (read or create): 422
  `record.invalid` `Signer in the request does not match the signer in the data`. An
  unknown signer: `record.relation-not-found` `Referenced Signer ghost not found.`
- A key pair without `secret` is served with **`secret: null`**, outside the hash and
  not in the changes. So an SDK `from(read).hash().sign()` proof is signed over the
  wrong hash and refused `crypto.signature-invalid` — on the reference as here.
- **`oauth-client-credentials`**: the ledger adds `clientId` (22 chars) and
  `clientSecret: "{{ secret.clientSecret }}"` (value 43 chars base64url) and re-hashes
  the data; the **client's proofs are dropped**, no status, `owners: []`, one system
  proof without status. Giving `clientId` is refused (`…allowClientCredentials flag…`).
- **`?include=meta.secret` reveals secrets in the clear** — a key pair's private key
  included — on create and read. Without it, never. (We additionally require `read`
  on `signer-factor-secret`; with the scenario's open ledger rule the reference's own
  rule could not be told apart.)
- Lists carry `page.total: 0` whatever they hold. After a drop the changes are gone
  too: by luid → 404 `Record not found` (the docs say they stay).
- **`POST /oauth/token`**: RFC 6749 JSON, unsigned. Without an authentication policy
  400 `invalid_grant` `OAuth is not enabled for this ledger`; missing `grant_type` 400
  `invalid_request`; another grant 400 `unsupported_grant_type`; no credentials 400
  `invalid_request`; wrong secret or unknown client 401 `invalid_client`. Form fields
  work as well as Basic. The token: RS256, `kid` = the provider's key-pair factor
  handle, claims `iss` provider, `cid` factor, `sub` its signer, `aud` the server's
  public URL, `exp − iat` = `jwt.ttl`; `expires_in` the same.
- An OAuth token **impersonates its `sub`** on a token-only mutation: the `system.auth`
  proof has `origin: oauth2-token`, `issuer: <provider>`, `bearer.cid`. A forged
  signature: 401 `Invalid token.` An empty `hash` on a body is a schema error
  (`request/body/hash must match pattern`).
- **`hsh` is checked**, against the server's **public** address
  (`https://ldg-stg.one/api/v2/…`): a hash over the address the client actually used
  (the recording proxy) is refused, as is another path, another `x-ledger` value, a
  garbage hash, a header named but not sent, a different method or body, or a query
  left out. An empty `hsh` binds nothing; without protected headers the hash has
  `headers: null`. The SDK's `createHsh` therefore fails behind any proxy.

## 2026-10-10 — Claim permissions: destroy, and permissions before limits

Recorded with `conformance/scenarios/claims2.ts` (15 exchanges), reproduced. B has
`destroy` on the symbol and `spend` on `bw` only.

- **`destroy` needs `spend` on the source too**: B's destroy from alice stayed pending
  after `resolved` and expired (`core.intent-expired`); from `bw` it completed.
- **Permissions before limits**: B's transfer of 5000 from alice (balance 1000, no
  `spend`) expired instead of failing on `minBalance`; the same from `bw` failed at
  once with `core.limit-exceeded`.

## 2026-10-10 — Aggregated limits (`dailyCount`, `dailyAmount`)

Recorded with `limits2` (67 exchanges), `limits3` (27), `limits4` (17) and `limits5`
(28) on 2.47.4; each follow-up settled what the one before left ambiguous. Reproduced,
with the stuck intents listed in `divergences.json`.

- Only with ledger config `limits.aggregated.enabled: true` (set by `PUT /ledger`).
  With it off, a `dailyCount` limit claim leaves the intent **`committed` forever** with
  `core.unexpected-error` `Ledger failed to commit intent`; the limit is not stored.
- **Counting starts with the intent that sets the limit** (transfers before it do not
  count, even with the config on) and the limit intent itself counts for
  `dailyCount`, as does every later limit intent on the wallet (raising 3 → 6 left
  room for two more, not three).
- `dailyCount`: one per intent that transfers the symbol through the wallet, **either
  way** (a credit from carol was refused), however many claims (a two-claim intent
  counted once). **Issues do not count.**
- `dailyAmount`: sum of transfers through the wallet, either way, **in minor units**
  (limit 400: 350 out then 100 out refused; 100 in refused as well). Issues do not
  count (bob: 300 issued + 301 out + 1 in under 500 passed).
- Both bounds are inclusive. Details: `Daily transactions limit exceeded for wallet
  <w>`, `Daily amount limit exceeded for wallet <w>`, reason `core.limit-exceeded`.
- **Like `maxBalance`, checked only after commit**: a breaking intent stays
  `committed` forever, its debit reserved; it does not count towards later checks.
- A daily limit touches no balance row. **A `minBalance` limit on a wallet without a
  balance creates an `available` row of 0** (no `parent`).
- The 24-hour window and its boundary (rolling or UTC day) are not recorded; we use
  a rolling 24 hours.

## 2026-10-10 — Access policies and the policy-based strategy

Recorded with `conformance/scenarios/policies.ts` (65 exchanges) and the follow-up
`policies2.ts` (36) on 2.47.4, both reproduced. Several docs claims do not hold.

- **`{policy: handle}` in a record's or the ledger's `access`** stands for the values
  of that `schema: access` policy and of the policies it `extend`s (the extended
  policy's own `record` applies to its values). A value without `record` takes the
  policy's `record`: `wallet-updater` (record `wallet`) attached to a symbol grants
  nothing on the symbol.
- A handle that names no policy is accepted on create (201) and grants nothing.
- **Record-based: the policy's status does not matter** (inactive still grants).
- **`access.strategy: policy-based`**: the ledger's and the records' own rules no
  longer count, **the server's default `{read, record: ledger}` neither**. The rules
  are the values of the **active** access policies; an extended policy contributes
  even when it is not active. Entering the ledger (the gate) needs an active policy
  granting `access` (record `ledger` or `any`).
- **The migration is not one-way** (docs: it is): `PUT /ledger` back to `record-based`
  is 200. Owners are still stored on new records (docs: they are not).
- **The gate applies to reads**: a wallet rule `{read, bearer: C}` does not let C read
  without `access` on the ledger. A read passes the gate anyway when a ledger (or
  server) rule grants that read itself (`{read, record: any}`, access4). A signer rule
  `{access, signer: B}` is satisfied by B's **token** key for reads.
- **Access check** lists rules without `signer` **and `bearer`**, a policy as its
  values; it needs no `read` on the record (B, who may not read `w2`, got `[]`).
- Policy create carries `status: created` in both proofs; status proofs on access
  policies (`active`/`inactive`) go through `access-policy:status` (empty quorum).

Not recorded: domain-specific policies (`handle@domain`), value `filter`, `invoke`.

## 2026-10-09 — Domains

Recorded with `conformance/scenarios/domains.ts` on 2.47.4 (31 exchanges), reproduced.
Access inheritance is not recorded yet (the scenario ledger grants everything).

- `$dom` records: create, read, list, `PUT`; no drop in the spec. `data` has
  `unevaluatedProperties: false`. Duplicate: 409 `Domain with handle <h> already exists.`
- A record's domain, set at creation and shown last in `meta` as `meta.domain`:
  a proof's `custom.domain` if any (it wins over the handle), else the suffix of a
  handle with **exactly one** `@` (`treasury@payments` → `payments`; `w@eu@payments`
  joins no domain although a domain `eu@payments` exists). Records created before the
  first domain keep none. Seen on wallets, symbols and domains.
- An unknown domain: 422 `record.relation-not-found`, `Trying to set a domain which
  doesn't exist "nowhere" to the record "y"`, `custom: {domain: "nowhere"}`.
- **A subdomain stores its parent in `data.domain`**, right after `handle`, with the
  client's hash unchanged (like a ledger's `config: null`).
- `GET /wallets?meta.domain=payments` filters; `GET /domains?meta.domain=…` is 400
  `api.query-malformed`, `Unsupported filters: 'meta.domain'`.
- Intents: `meta.domains` lists the domains of the wallets the claims name (`['payments']`
  for an issue to `treasury@payments`, and for a transfer from it to a wallet without
  one), already in the `POST` response; `GET /intents?meta.domains=payments` filters.

## 2026-10-09 — Wallet anchors and domains from a bridge

Recorded with `conformance/scenarios/anchors2.ts` on 2.47.4 (19 client exchanges, 6
bridge calls; the first recording answered full records and was refused). Reproduced.

- The paths are those of the about-bridges trait table: `GET {server}/wallets/<address>/anchors`,
  `POST {server}/wallets/<address>/anchors/!lookup`, `GET {server}/wallets/<address>/domains`.
  `<address>` is the one the client asked for, unencoded (`tel:9@acc`); the bridge is
  that of the wallet the address resolves to (`acc`). The other three paths the docs
  give (`/v2/anchors`, `/v2/wallets/:handle/!lookup`, `/v2/wallets/:domain`) are not used.
- Headers: **the client's own `authorization`** and `x-ledger`; no ledger token.
- The lookup body is the client's `{hash, data}` with its proofs **replaced** by one
  ledger `system` proof `{moment}`.
- Only a bridge whose traits allow it is asked (`traits` without `anchors` → the ledger
  answers itself). When asked, **the bridge's answer replaces the local anchors**: a
  local anchor of the same wallet is not listed.
- The bridge answers a signed list of records' **data**; each item comes back as
  `{data: {access: [], …item}, meta: {}}` in a signed list without `page`. Full records
  (`{hash, data, meta}`) are refused: 500 `bridge.proxy-response-invalid`,
  `Invalid response from bridge while querying anchors|domains`.
- Lookup whose `data.wallet` is not the path's address (or is missing): 422
  `record.invalid`, `Address in the request does not match the address in the data`.
- A wallet without a bridge: anchors and domains `[]` (no domains held locally).

## 2026-10-09 — Anchors as records

Recorded with `conformance/scenarios/anchors.ts` on 2.47.4 (29 exchanges), reproduced.
No bridge: what a bridge with trait `anchors` adds is not recorded yet.

- `$anc` records with the generic surface (create, read by handle or luid, list with
  filters, `PUT` with `parent`, status by proof, changes, drop). Their change entries
  have **no `meta.labels`** (every other kind's have `labels: null`).
- `target` is required (422 `…/data must have required property 'target'`), and
  `data` has `unevaluatedProperties: false` (422 `request/body/data must NOT have
  unevaluated properties`, path `/body/data`).
- **A wallet is required and must exist even without `anchor.walletRequired`**:
  422 `record.relation-not-found`, `Cannot find anchor wallet 'undefined'` (none named)
  or `'ghost'`. The docs say anchors may exist without a wallet unless the option is set.
- Duplicate handle: 409 `Anchor with handle <h> already exists.`
- `GET /wallets/{h}/anchors`: the anchors whose `data.wallet` is `h`, newest first, a
  signed list **without `page`**; an unknown wallet gives an empty list, not 404.
- Dropping a wallet that anchors name (recorded with `anchor.walletRequired: true`):
  422 `record.drop-rejected`, `Cannot drop wallet 'bob' with anchors associated with
  it`, `custom.anchors: [handles, oldest first]`.

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
