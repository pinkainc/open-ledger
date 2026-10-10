# TODO

Working list, kept in the repo so progress survives between sessions. Checked items
are done and verified (tests green + conformance where a scenario exists). Newest
decisions go into `FINDINGS.md` (reference behaviour) or the README (design).

Plan to full parity, session by session: `docs/2026-10-10-plan-do-paritete.md`;
handoff per session in `docs/handoffs/` (chain rules and status in its README).

Legend: `[x]` done · `[ ]` open · `[~]` in progress · `(?)` needs a sandbox recording first

## L0 — ledger, symbol, wallet (records only)

- [x] Recording proxy, comparator, runner (`conformance/`)
- [x] Reference fixture `l0.reference.jsonl` (18 exchanges)
- [x] Server: create/read ledger, symbols, wallets; list; wallet balances (empty)
- [x] Per-ledger `system` signer; errors signed once the ledger is resolved
- [x] Ledger-level access rules, anonymous access when a rule names no principal
- [x] Unit tests: crypto against a real Minka signature, app via the official SDK
- [x] Pagination: `?page.index=&page.limit=` (recorded in L3), echoed in `page`
- [x] Verify the `hsh` token claim against `PUBLIC_URL` (recorded `hsh` 18/18; run.sh points both at the reference's address)

## L1 — money moves (one ledger, the ledger is the only participant)

- [x] Intent/claim/balance semantics from docs (agent report) and from the sandbox (FINDINGS)
- [x] L1 scenario recorded: issue, transfer, destroy, overdraw, unknown wallet/symbol, partial, schema errors
- [x] Intents: create (async processing), read, list newest first
- [x] Claims `issue`, `transfer`, `destroy`; proof trail identical to the reference (30/30)
- [x] Balances: available / reserved rows, reservation on debit, clearance
- [x] Ajv validation with the reference's error shape (all kinds, not only intents)
- [x] Postgres store: records, balances, per-ledger signers; ledger-serialised transactions
- [x] Tests: behaviour, model-based random sequence, conservation of supply, 50 concurrent
      transfers, two processes on one Postgres, crash recovery, idempotent processing
- [x] Wallet and symbol lists are newest first (recorded in L3)
- [x] Mixed intent: core participates for every entry when any debit exists (recorded)
- [x] Unknown source message (recorded; the guess was right)
- [x] Unknown wallet is reported before unknown symbol (recorded; order fixed)
- [x] Claim authorisation: see L4
- [ ] Per-wallet locking instead of the ledger-wide advisory lock (throughput, not correctness)
- [x] Read by luid as well as handle (all record kinds)

## L2 — multi-claim intents

- [x] All-or-nothing across claims (reference `i-partial`, unit tests incl. two debits of one wallet)
- [x] Multi-symbol intents (recorded `i-multi`)

## L3 — limits and reservations

- [x] `limit` claims: `minBalance`, `maxBalance`; `GET /wallets/{id}/limits` (signed rows)
- [x] Credits never offset debits (docs say otherwise; reference and we agree)
- [x] maxBalance checked before prepare — deliberate divergence from a reference bug
- [x] Divergence register `conformance/divergences.json`, reported by the comparator
- [x] `dailyAmount`, `dailyCount` (need `limits.aggregated.enabled`): recorded `limits2`–`limits5`;
      stuck intents of the reference rejected by us (divergences.json)
- [ ] (?) The daily window: rolling 24 hours (ours) or a UTC day; a destroy towards dailyAmount
- [ ] Daily limits read every completed intent of the ledger per check; keep aggregates instead
- [x] L6 unit test "a bridge that never answers a prepare" timed out: the unit tests' Postgres database had grown to
      3735 ledgers and the expiry scan read them all; `check.sh` now gives the tests an empty one per run
- [x] A limit on a wallet with no balance row creates an `available` row of 0 (`limits2`); a daily one does not
- [ ] Balance reservations visible while an intent is in flight (only matters once
      intents wait on external participants, L5)
## L4 — signatures, quorum, status policies, record-level access

- [x] Generic lifecycle for symbols, wallets, signers: `PUT` update with parent hash,
      status by proof, `changes` (+ single change), access check; wallet drop (`DELETE`, `POST …/drop`)
- [x] Signers (`$snr`), and the four server signers every ledger publishes
- [x] Access rules per about-authorization: `signer` → proof signers (mutations only),
      `bearer` → token (claims, `$signer`), neither → everyone; record → ledger → server, additive
- [x] Server rules configurable; default: `access`, `read ledger`, `create ledger`
- [x] `signer: {handle}`, `$circle`, `$record: owner`, `$ledger: owner` matchers (`server/src/access.ts`)
- [x] Rule scope (ledger rule without `record` = ledger only) and the ledger `access` gate — recorded access2/3
- [x] Circles, circle signers (`$crc`, `$csn`), policies (`$plc`); status policies with quorum (`server/src/status.ts`)
- [x] Proofs by registered signers annotated with `signer: <handle>`
- [x] `access3` #7 — token impersonation: a token whose key is a registered signer gets a
      `system.auth` proof (`self-signed-token`, `bearer.*` claims); token-only bodies and
      partial proofs; spoofed origin/signer/issuer on client proofs are stripped (16/16)
- [x] access2 and access4 compared; waits end on a forbidden or missing intent (check: 36 s total).
      access2 15/15 in `npm run check`. The access4 fixture had 36 exchanges of a concurrent
      l0/l1 run mixed in (shared proxy) — removed; `run.sh` now refuses busy ports and keeps
      only the run's own ledger when recording (`conformance/own-ledger.ts`)
- [x] Forbidden details: `Cannot <action> <record>.` — no soft `detail` difference left at any level
- [x] Tests for scope, gate, 403 details, bearer and signer matchers, circles, status policies (`access.test.ts`)
- [x] Access policies (`{policy: handle}`, `extend`) and `access.strategy: policy-based`
      (recorded `policies` 65/65, `policies2` 36/36); the gate applies to reads
- [ ] (?) Domain-specific access policies (`handle@domain`), policy value `filter`, `invoke`
- [x] Claim authorisation: `spend` on the source, `issue`/`destroy` on the symbol, `limit` on the
      wallet, by the intent's signers (impersonated proofs count as the token's signer, with its
      `bearer.*` claims). Without it the intent waits after resolution and expires (access4 14/14)
- [x] `destroy` needs `destroy` on the symbol **and** `spend` on the source (recorded `claims2`)
- [x] Claim permissions are checked before limits: an overdraw without `spend` expires (`claims2`)
- [ ] (?) Record reference: drop of a funded wallet (our reason `record.drop-rejected`, wording ours)
- [x] Drop of bridges and policies (`DELETE`, `POST …/drop`): a bridge a wallet names is
      `record.drop-rejected`; system policies may be dropped (recorded `drops` 19/19)
- [x] `PUT /ledger`, `POST /ledger/proofs`, `/ledger/changes/{n}`, `/ledger/access/!check` (records2 52/52)
- [x] Access check as recorded: check-request proofs for every action, rules without `signer`,
      record rules named by kind, ledger rules first, server rules not listed
- [x] System status policies `intent:status`, `access-policy:status`; status policy `filter`
- [x] Intent changes per stage; `POST /intents/{id}/proofs` appends a signature
- [ ] (?) What makes a waiting intent proceed once its missing signature arrives? A plain proof did
      not (records2). Try a proof with `custom.status` (`pending`? `created`?) in a recording
- [x] `GET /ledgers` — recorded (`ledgers`), filtered on the run's `custom.run`: owned ledgers, newest first; a stranger `[]`, anonymous 403, `x-ledger` 422
- [x] Lists are newest change first (`meta.moment`, recorded `uschema2`); ties (a ledger's system records) come in no fixed order on the reference
- [x] Lists are `query`: the ledger gate decides (`Cannot query wallet.`), then the page keeps what the caller may read (the filter is ours: no recording has a record hidden from a list yet (?))
## Authentication (recorded: `factors` 43/43, `oauth` 21/21, `hsh` 18/18)

- [x] Signer factors `$snf`: 9 operations, generic lifecycle, `secret: null` on key pairs,
      generated OAuth client credentials, signer in path vs data, list `total: 0`
- [x] `POST /oauth/token` (client credentials → RS256 JWT from the provider's key-pair factor)
- [x] RS256 bearer tokens: `kid` = a provider's key-pair factor; impersonation with
      `origin: oauth2-token`; external IdPs work the same way (not recorded)
- [ ] (?) `/oauth/token` with bad credentials and no policy: `invalid_grant` or `invalid_client`? (we: policy first)
- [ ] (?) Does a read with `include=meta.secret` return the creation's client secret? (we: yes)
- [ ] (?) An authentication value's `target.schema`; an external IdP token whose `sub` is no signer
- [ ] (?) Who may `include=meta.secret` (we: `read` on `signer-factor-secret`)
- [ ] `signer.factor.oauth.allowClientCredentials`: own credentials accepted, not recorded

## Reports (recorded: `reports` 49/54 + 13/14, `reports2` 236/243; the rest deliberate)

- [x] `$rep` records: 9 operations, schema required, custom validated by the report schema
- [x] `report-created` → effect → reporting bridge (`/effects/{effect}`); `report-proofs-added`
      also for the ledger's `created` proof
- [x] Status table (25 pairs recorded); a repeated status is dropped (no proof, change, event)
- [x] Assets on `completed`: bucket (`OPEN_LEDGER_REPORTS_BUCKET`), path shape, file = handle;
      422 where the reference answers 500 (divergences.json)
- [x] `GET /reports/{id}/assets/{asset}` from `OPEN_LEDGER_REPORTS_DIR` (the reference reads GCS)
- [x] `minka report create/list/show/sign/changes/drop` in `scripts/cli-e2e.sh`
- [ ] (?) Asset path: are the ledger and luid in it checked? A report in a domain (`/domains/{d}/`)
- [ ] (?) Status policies on reports; `report-dropped` (we raise it; not recorded)
- [ ] (?) Do not record a download of an asset missing from the bucket: it drops the reference's connection

## L5 — 2PC with one external participant (bridge), idempotency by handle

- [x] Recording through a tunnel: `conformance/bridge.ts`, `needs-bridge` in run.sh, bridge
      logs compared in a canonical order (by intent, then phase)
- [x] Bridges (`$brg`, schema `rest` required), wallet `bridge` reference
- [x] Core as a state machine over the trail: prepare calls (debits first), wait for reports,
      commit / abort (reverse), status notifications, core aborted + release on rejection
- [x] Retries (1 s, ×1.2, ≤ 1 h; 501 stops), resume re-sends calls in flight (same `$ben` luid)
- [x] Invariant: a report delivered twice has the effect of one (`l5.test.ts`); intent status is
      never set by a proof on the intent (found by that test)
- [x] Expiry of an intent waiting for a bridge aborts the bridge and releases the reservation
- [x] `secure` rules `header` and `oauth2`, secrets from `meta.secret` sealed with AES-256-GCM
      under `OPEN_LEDGER_MASTER_KEY` (recorded `secure`, 43/44 + 39/39)
- [x] `traits`: methods listed, `{method, filter}` on the call's data; no `statuses` → no PUT
- [x] OAuth2 token cache (`oauth2.ts`: JWT `exp`, else `expires_in`, ≥ 60 s, dropped 30 s early; the reference has none)
- [x] Generic `secure` rules — recorded (`secure2`): the reference makes no call for any generic rule (mtls too, valid key too): `delivery.unexpected-error` ×6, then cancelled, intent noted `No handler found for security rule schema …`. Ours the same for unknown schemas and mtls over http; mtls over https presents the certificate (divergences.json, `server/test/mtls.test.ts`); `OPEN_LEDGER_BRIDGE_CA` for a private CA
- [ ] Bridge proof authorization: may a signer that is not the bridge report `prepared`/`committed` for a bridge's entry? (plan S4 item 6, moved to S5)
- [x] Secrets of signer factors, sealed like bridge secrets; `include=meta.secret` serves them (recorded `factors`)
- [x] Debit and credit on the same bridge in one intent; grouping (`claims.groupBy`) — l6
- [x] A commit report that never comes: the intent stays `committed` (recorded, l6; same here)
- [ ] Bridge proof authorisation: today any signer allowed to sign the intent may report
- [x] Routes (`wallet.routes`), address resolution `schema:handle@parent` — see Routes below
- [x] `/bridges/{id}/events` (deliveries) — L8
## Routes and addresses (recorded: `routes`, 62/62 + 18/18)

- [x] Address hierarchy `schema:handle@parent → schema@parent → parent → schema` (`routing.ts`)
- [x] Routes: `credit`, `debit`, `accept` with filters (claim paths, `ctx.intent`, operators),
      unmatched in/out routes, cycles; resolved proof names the wallet, bridges get the address
- [x] `forward`: a new intent of the same thread by the ledger (`data.origin`), no core, no
      reservation, no permission check
- [x] Spend permission on the wallet an address resolves to
- [x] Balance rows: `parent: ""` on every update, not only reservations (all recordings)
- [x] Route depth: three hops resolve, a fourth is `Max wallet routing depth reached for intent …` (routes2)
- [x] Debit routing cycle wording mirrors the credit one (routes2)
- [x] A forward intent that fails rejects its thread, the first intent too (recorded, l7)
- [x] Route target that does not resolve: `Credit routed wallet not resolved … Parent wallet: <route's wallet>` (routes2)
- [x] Anchors as records (`$anc`, full surface, drop), wallet required and existing,
      `GET /wallets/{h}/anchors` local; a wallet with anchors is not dropped (recorded `anchors` 29/29)
- [x] Wallet drop with anchors is refused with `walletRequired` off too, anchors newest first (routes2)
- [x] Wallet anchors and domains from a bridge (traits `anchors`, `domains`), resolved by
      address; `POST /wallets/{h}/anchors/!lookup` (recorded `anchors2` 19/19 + 6/6)
- [x] Lookup on a wallet without a bridge: always `[]`, local anchors or not (routes2)
- [x] Bridge `secure` headers apply on anchor/domain calls, beside the client's token (routes2)
- [x] The bridge's list signature and hash are not verified (routes2)
- [x] Who may report on an entry: `create` on `intent-proof` from the ledger's rules, any
      such key (not only the bridge's); `sign` is no access action, every `access` is
      validated against the spec (recorded `bproofs` 45/45 + 20/20)
- [ ] DTC policy (`schema: dtc`, configurable 2PC steps; spec since 2.46, no prose docs) —
      a whole executor, moved to S10 (scoped in S5)
- [x] Anchor forwarding (processing policy, strategies proxy/fallback/validate/synchronize) —
      `forwarding` 65/67 + 29/30 (synchronize `sign` is a reference 500, divergences.json);
      `server/src/forwarding.ts`, `server/test/forwarding.test.ts`
- [ ] Processing policy `filter` (spec: policy-filter) — not recorded, not applied
- [x] Domains: `$dom` records, `meta.domain` from a proof or a one-`@` handle suffix,
      subdomain `data.domain`, intent `meta.domains` (recorded `domains` 31/31)
- [x] Domain access inheritance (rules of a domain apply to its records and subdomains) —
      `domains2` 43/43 (access.ts: domain level between record and ledger)
- [ ] (?) Updating a subdomain: its stored data has `domain`, which the schema forbids
- [ ] (?) `meta.domains` of a forward intent, and order with several domains
- [ ] (?) `domain.resolutionFromHandleEnabled: false` (domain only from proofs)

## L6 — N participants, ordered prepare/commit/abort, timeouts, crashes

- [x] Scenario `l6` with two bridges behind one tunnel (`startBridges`, path prefix per
      bridge), recorded: 34/34 client exchanges, 75/75 bridge calls
- [x] Parts (`Part` in core.ts): an entry, or a `groupBy` group with a derived handle
- [x] Two-phase prepare: debits, then credits once all debits are prepared (current intent,
      `domains: []`); the credit phase is marked with `Store.once`, so it goes out once
      however many passes follow (test fails without the mark)
- [x] Abort and status notifications only to parts asked to prepare; aborts in parallel
- [x] A silent prepare: the intent expires and the part is aborted (recorded)
- [x] Comparator: adjacent same-status reports of several bridges in canonical order
- [ ] (?) What if a bridge reports `prepared` for a part after the intent was aborted (our
      bridge test sends it; the reference's answer to a late report is not recorded)
- [ ] (?) A debit on one bridge failing while another bridge's debit is still pending
- [ ] Crash in the middle of the credit phase: redrive re-sends the credits (mark set);
      covered by `resume`, not by a test yet
- [ ] (?) Commit never confirmed: is there any reconciliation on the reference (none seen)?
- [x] v2.47.0: the core aborts its entries and releases reservations at `aborted`, not
      when the last bridge confirms; abort calls carry `domains: []` when the core took
      part (recorded `abort` 16/16 + 8/8; l5, l6, l7 re-recorded on 2.47.4)
## L7 — expiry and thread abort

- [x] Expiry job (`Core.startExpiry`): pending intents older than `intent.expiryThresholdMinutes`
      (from the client's `created` proof) get failed `core.intent-expired` → aborted → rejected.
      No threshold in the ledger config → no expiry. `OPEN_LEDGER_MINUTE_MS` shortens it for
      conformance (run.sh sets 1000 ms)
- [x] Threads (recorded `l7`): the first intent waits `prepared` until every forward intent of
      its thread is prepared, commits first, forward intents after the intent that made them
- [x] Thread abort: one intent fails → the others fail with its reason and detail, release
      their reservations, abort their bridges (refused forward, bridge failure, expiry)
- [x] Release reservations of an expired intent (bridge wait: core prepared → released; a
      signature wait reserves nothing)
- [x] Thread size cap 10 (`core.thread-size-exceeded`) checked when forwarding — divergence:
      the reference checks after the fact and let a loop make ~5000 intents (FINDINGS)
- [x] Expiry of a forward intent waiting for its bridge — divergence: the reference never
      expires it (thread stuck); we expire it and abort the thread
- [ ] Thread lookups scan the ledger's intents (only for threads with a forward); index by
      `meta.thread` in Postgres if it shows up
- [ ] Reports `$rep` (9 operations) and the reporting bridge protocol (plan S3)
- [x] `GET /system/requests[/{id}]`, `POST /ledger`, `DELETE /ledger` — recorded (`ledgers`): journaling and ledger drop are off on the sandbox; ours too by default, on with `OPEN_LEDGER_JOURNAL` / `OPEN_LEDGER_LEDGER_DROP` (unit tests only)
- [ ] Unsupported list filters → 400 `api.query-malformed` `Unsupported filters: '<f>'`
      (seen for `data.origin` on intents); which fields are supported per kind is unknown (?)
## L8 — event delivery, retries, `cancelled` (recorded: `events`, 23/23 + 20/20)

- [x] Deliveries `$evd` as an outbox: written in the transaction of the step that makes the
      call, attempted by `Bridges`, one signed proof per attempt, `replay`, `cancelled` on 501
- [x] `resume` sends pending/failed deliveries with their output unchanged; the redrive that
      recomputed calls from the trail is gone
- [x] A cancelled delivery notes its intent (`error`, `core.bridge-unreachable`)
- [x] `GET /bridges/{id}/events[/{handle}]`, `POST …/events/retry` (handle or `maxAge`),
      access `query-event` / `retry-event`
- [x] Unreachable target (network error): `delivery.target-unreachable {message, code}` —
      from the docs, not recorded (the shape of `detail` is ours)
- [x] Retry cap: 5 retries, then `cancelled delivery.retry-cap-exhausted`; the last failed
      attempt carries `detail.body` (recorded); `OPEN_LEDGER_DELIVERY_MAX_RETRIES`
- [x] `POST /bridges/{id}/activate` (deprecated bulk retry); deliveries `running` while attempted
- [ ] (?) Does bulk retry include `cancelled`? (we: failed, cancelled, pending)
- [x] Effects (`/effects`, recorded in `effects`): record `$eff`, validation, drop; events
      `evt_` signed by `system`, one per occurrence for every effect on the signal whose
      `filter` matches; webhook or bridge (`POST …/effects/{effect}`, trait `effects`);
      deliveries `/effects/{id}/events[/{handle}]`, retry, activate, through the same outbox
- [x] Signals raised: `<record>-created|updated|proofs-added` for every record kind,
      `effect-dropped`, `intent-created`, `intent-updated` (per version, with `parent`),
      `balance-received`
- [ ] (?) Signals not recorded: `*-proofs-added` payload, bridge-entry-*, wallet-limited,
      intent-updated of a bridged or rejected intent, balance-received of several credits
      to one wallet (summed or one each?)
- [ ] (?) Effect retry of a webhook unreachable on the network (we: `target-unreachable`)
- [ ] `minka bridge events list|show|retry` in the CLI end-to-end
## L9 — cross-ledger

- [x] Two ledgers joined by a bridge (`connecting-systems/cross-ledger-payments.md`): adapter
      `bridges/ledger-bridge` (2PC calls → intents downstream: hold, destroy, issue); recorded
      `l9` on two sandbox ledgers, 40/40 + 51/51 on the first run
- [x] Two of our servers joined by the adapter (`server/test/l9.test.ts`): supply mirror after
      concurrent random payments, forged call refused (401), entry recovered after a restart
- [x] Ours ↔ Minka, both directions (`l9mixed`, 31/31 + 78/78): Minka clears for our bank
      ledger and ours for a Minka bank ledger; mirror holds both ways; in the README
- [ ] The adapter keeps prepared entries in memory; a restart between prepare and commit
      recovers them from the intent, but runs in flight are lost (the ledger retries)

## E2E — the official `minka` CLI

- [x] `scripts/cli-e2e.sh`: connect, signer, ledger, symbol, wallets, issue, transfer, balances,
      lists, filtered intent list, schema list, reports (S3) — 30 steps, balances checked over HTTP; part of
      `npm run check` (Postgres, ~16 s)
- [x] `GET /api/v2` server info (`{handle, server, semver, status}`), `PUBLIC_URL`, `SERVER_HANDLE`
- [x] Ledger create without a token (the CLI sends none; the proofs sign it)
- [x] Schemas `$sch`: the 12 system schemas per ledger, full record surface; list filters
      (`query.ts`, about-queries: `$eq $ne $gt $gte $lt $lte $in $nin $regex`, array fan-out,
      index, `$plainTextQuery`)
- [x] User schemas enforce records: the named schema validates `data`, every error;
      a record must name one once its kind has one; content checked as JSON Schema
      (recorded `uschema` 35/35, `server/src/user-schemas.ts`)
- [x] Schema `extend` — recorded (`uschema2`): kept as given, never applied; any parent accepted (unknown, another kind, itself). A cycle only in unit tests
- [ ] Record the CLI flow against the sandbox as a conformance level (shell scenario in run.sh;
      `GET /api/v2` would be a divergence: handle, semver)
- [ ] Unsupported filter fields: the docs say the reference answers an error — record (?)

## Tooling

- [x] Coverage report `COVERAGE.md` (`npx tsx conformance/coverage.ts`, part of `npm run check`)
- [x] `npm run check`: typecheck, unit tests and every level's conformance, on memory and Postgres
- [x] Postgres conformance runs get an empty database each (`dev-db.sh fresh`): a server
      resumes every unfinished intent, and l6 leaves one on purpose
