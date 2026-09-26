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
- [ ] Pagination query parameters (`page[index]`, `page[limit]`) — record reference first (?)
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
- [ ] (?) Wallet and symbol lists: assumed newest first like intents — record a 2-item list
- [ ] (?) Mixed intent (issue + transfer): does the core participate? Assumed yes if any debit
- [ ] (?) Unknown *source* wallet message: assumed "Source wallet not resolved …"
- [ ] (?) Claim with both unknown symbol and unknown wallet: which is reported first
- [ ] Claim authorisation: `spend` on source wallet, `issue`/`destroy` on symbol (L4 access)
- [ ] Per-wallet locking instead of the ledger-wide advisory lock (throughput, not correctness)
- [ ] Read intent by luid as well as handle

## L2 — multi-claim intents

- [x] All-or-nothing across claims (reference `i-partial`, unit tests incl. two debits of one wallet)
- [ ] (?) Multi-symbol intents (claims in two symbols) — record reference

## L3 — limits and reservations
## L4 — signatures, quorum, status policies, record-level access
## L5 — 2PC with one external participant (bridge), idempotency by handle
## L6 — N participants, ordered prepare/commit/abort, timeouts, crashes
## L7 — expiry and thread abort
## L8 — event delivery, retries, `cancelled`
## L9 — cross-ledger

## Tooling

- [ ] Coverage report: implemented operations vs the 146 in Minka's spec
- [x] `npm run check`: typecheck, unit tests and every level's conformance, on memory and Postgres
