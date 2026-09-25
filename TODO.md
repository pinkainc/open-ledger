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

## L1 — money moves (one transfer, the ledger is the only participant)

- [ ] Extract intent/claim/balance semantics from docs (agent report → FINDINGS)
- [ ] L1 scenario against the sandbox: issue, transfer, balances, insufficient funds (?)
- [ ] Intents: create, read, list; claims `issue`, `transfer`, `destroy`
- [ ] Balances computed from committed claims; per wallet × symbol
- [ ] Invariant: sum of balances per symbol = issued − destroyed (property test)
- [ ] Invariant: no balance below zero unless a limit allows it
- [ ] Postgres store behind `Store`; memory store kept for unit tests
- [ ] Concurrency test: N parallel transfers from one wallet never overdraw

## L2 — multi-claim intents
- [ ] All-or-nothing across claims; never a partial subset committed

## L3 — limits and reservations
## L4 — signatures, quorum, status policies, record-level access
## L5 — 2PC with one external participant (bridge), idempotency by handle
## L6 — N participants, ordered prepare/commit/abort, timeouts, crashes
## L7 — expiry and thread abort
## L8 — event delivery, retries, `cancelled`
## L9 — cross-ledger

## Tooling

- [ ] Coverage report: implemented operations vs the 146 in Minka's spec
- [ ] CI-style `npm test` that runs unit tests + conformance check for every level
