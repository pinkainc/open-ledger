# TODO

Working list, kept in the repo so progress survives between sessions. Checked items
are done and verified (tests green + conformance where a scenario exists). Newest
decisions go into `FINDINGS.md` (reference behaviour) or the README (design).

Legend: `[x]` done · `[ ]` open · `[~]` in progress · `(?)` needs a sandbox recording first

## L0 — ledger, symbol, wallet (records only)

- [x] Recording proxy, comparator, runner (`conformance/`)
- [x] Reference fixture `l0.reference.jsonl` (18 exchanges)
- [x] Server: create/read ledger, symbols, wallets; list; wallet balances (empty)
- [x] Per-ledger `system` signer; errors signed once the ledger is resolved
- [x] Ledger-level access rules, anonymous access when a rule names no principal
- [x] Unit tests: crypto against a real Minka signature, app via the official SDK
- [x] Pagination: `?page.index=&page.limit=` (recorded in L3), echoed in `page`
- [ ] Verify the `hsh` token claim (needs the client-visible URL; `PUBLIC_URL` setting)

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
- [ ] Claim authorisation: `spend` on source wallet, `issue`/`destroy` on symbol (L4 access)
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
- [ ] `dailyAmount`, `dailyCount` (need `limits.aggregated.enabled`) — record reference (?)
- [ ] (?) A limit on a wallet with no balance row: does the reference create one?
- [ ] Balance reservations visible while an intent is in flight (only matters once
      intents wait on external participants, L5)
## L4 — signatures, quorum, status policies, record-level access

- [x] Generic lifecycle for symbols, wallets, signers: `PUT` update with parent hash,
      status by proof, `changes` (+ single change), access check; wallet drop (`DELETE`, `POST …/drop`)
- [x] Signers (`$snr`), and the four server signers every ledger publishes
- [x] Access rules per about-authorization: `signer` → proof signers (mutations only),
      `bearer` → token (claims, `$signer`), neither → everyone; record → ledger → server, additive
- [x] Server rules configurable; default: `access`, `create ledger` (divergence from the sandbox's wallet grant)
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
- [ ] NEXT: access4 is listed in `conformance/pending.json` until claim permissions and expiry exist
- [x] Forbidden details: `Cannot <action> <record>.` — no soft `detail` difference left at any level
- [x] Tests for scope, gate, 403 details, bearer and signer matchers, circles, status policies (`access.test.ts`)
- [ ] Access policies (`{policy: handle}`) and `access.strategy: policy-based`
- [ ] Status policies: allowed transitions, quorum (`record.status-policy-violation`, quorum-not-met)
- [ ] Circles and circle signers (`/circles`, `/circles/{id}/signers`)
- [ ] Claim authorisation: `spend` on source wallet, `issue`/`destroy` on symbol, `limit`.
      Recorded (access4): the intent stays pending and expires, `core.intent-expired`,
      `Intent <handle> expired`. Needs the expiry job (L7) first
- [ ] (?) Record reference: drop of a funded wallet (our reason `record.drop-rejected`, wording ours)
- [ ] `PUT /ledger`, `POST /ledger/proofs`, `/ledger/access/!check`, `GET /ledgers`
## L5 — 2PC with one external participant (bridge), idempotency by handle
## L6 — N participants, ordered prepare/commit/abort, timeouts, crashes
## L7 — expiry and thread abort
## L8 — event delivery, retries, `cancelled`
## L9 — cross-ledger

## Tooling

- [x] Coverage report `COVERAGE.md` (`npx tsx conformance/coverage.ts`, part of `npm run check`)
- [x] `npm run check`: typecheck, unit tests and every level's conformance, on memory and Postgres
