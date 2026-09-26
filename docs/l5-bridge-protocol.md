# L5 — the bridge protocol as documented (2026-09-26)

What the ledger must do to run two-phase commit with an external participant, taken
from the docs mirror and the `@minka/bridge-sdk` 2.18.0 source (`npm pack`, not in the
mirror). **Not recorded yet**: everything here is documentation until a sandbox
recording through a tunnel confirms it. Citations: `AB` about-bridges, `BB`
build-a-bridge, `AI` about-intents, `RP` resolution-proofs, `BR` balance-reservations,
`AW` about-wallets (all under `docs.minka.io/docs/ledger/`), `NS`
solutions/bank-integration-no-sdk, `OA` `_raw/openapi.yaml`, `SDK` bridge-sdk source.

## Bridge record (`$brg`)

`{handle, schema?, config: {server, "debits.claims.groupBy"?, "credits.claims.groupBy"?:
"address"|"wallet"}, secure: [...], traits?, custom?, access}` — `config.server` and
`secure` required, unknown fields rejected (OA:12405-12565).

- `secure` rules, applied in order (last write wins per header): `{schema: "oauth2",
  clientId, clientSecret: "{{ secret.x }}", tokenUrl, scope?}`, `{schema: "header", key,
  value}`. OAuth2: Basic `clientId:clientSecret`, reads `access_token`/`expires_in`,
  tokens under 60 s not cached (AB:542-679).
- `traits`: `debits|credits|statuses|anchors|domains|effects` (+ `ping` in OA), string or
  `{method, filter}`; absent = all on; filters apply to `data`, for debits/credits only
  at prepare (AB:86-155).
- The bridge's key needs `{action: "sign", record: "intent"}` (AI:487).
- Routes: `POST/GET /bridges`, `GET|PUT|DELETE /bridges/{id}`, `POST /bridges/{id}/proofs`,
  `/drop`, `/access/!check`, `/changes[/{n}]`, `/events…` (deliveries), `/activate`
  (deprecated).

## Routing

- `wallet.data.bridge` = bridge handle (OA:15618; AW:84-99). Address resolution
  `schema:handle@parent → schema@parent → parent → schema` (AW:33-47).
- Routes (`debit`/`credit`) send to the route target's bridge, depth 3, no cycles
  (AW:111-123).
- transfer → debit on source + credit on target; issue → credit only; destroy → debit
  only; issue/destroy record the bridge in resolution but do not call it (RP:15-17, 247).
- Resolution proof per entry: `{status: resolved, handle: deb_/cre_, schema, wallet,
  bridge?, symbol, amount, inputs, moment}` (RP:55-90) — **`bridge` is new vs. L1**.

## Ledger → bridge calls

Base is `config.server` (already includes `/v2`).

| Phase | Call |
| --- | --- |
| prepare | `POST {server}/debits`, `POST {server}/credits` |
| commit | `POST {server}/{debits,credits}/:handle/commit` |
| abort | `POST {server}/{debits,credits}/:handle/abort` |
| status | `PUT {server}/intents/:handle` (`statuses` trait) |

- Prepare body: a signed entry `{hash, data: {handle, luid?, schema, source?|target?:
  {handle}, symbol: {handle}, amount, intent: <full intent record>}, meta: {proofs:
  [ledger proof]}}` (AB:227-272; NS:401-470).
- Commit/abort body: `{hash, data: {handle, action: "commit"|"abort", intent: <current
  intent>}, meta: {proofs}}` (AB:281-366).
- The bridge verifies a proof by the ledger's `system` key over `record.hash`.
- Expected answer: **202, empty body**; a repeat with the same handle (+action) is 202
  and a no-op (SDK transactions.controller.js:17-44).
- Outbound headers beyond `secure`: undocumented.

## Bridge → ledger

Asynchronous: after 202 the bridge `POST /intents/:handle/proofs` with one proof per
call, JWT `iss: <bridge handle>`, `sub: "bridge:<handle>"`, `aud: <ledger>`.

- Success custom: `{moment, handle: <entry>, status: prepared|committed|aborted, coreId?}`
- Failure custom: `{moment, handle, status: failed, reason: "bridge.…", detail, …}`
- The ledger checks the signer has `sign` on the intent (bridge access) and that
  `custom.handle` is a resolved entry of that bridge (AI:289-310).

## Sequence

- Success: … resolved×N → bridge prepared×N → ledger `prepared` → bridge committed×N →
  ledger `committed` → `completed`.
- Failure: a bridge `failed` → ledger aborts → every participant (also the failing one)
  gets abort → bridges answer `aborted` → intent `aborted`, `rejected`.
- Prepare: debits first, then credits. Commit: parallel. Abort: reverse order (AI:74-77)
  or parallel (release notes v2.16.0) — unclear.
- Only prepare may fail; commit and abort are retried until they succeed.
- Retries from 1 s, +20 % each, capped at 1 h (AB:196-207); inspect-event-deliveries
  says unlimited, 60 s per call, HTTP 501 stops permanently.
- Idempotency key: entry handle (+ action).

## Balances

- Native debit wallets: reserved at prepare, consumed at commit, released on abort
  after bridges are told (BR:9-53). Credits never reserved.
- Bridged wallets: the bridge holds funds in its core; whether the ledger also reserves
  is not stated (BR:74-78).

## Open (answer by recording)

1. Headers the ledger sends to a bridge.
2. Abort order: reverse sequence or parallel.
3. Entry `luid` (the SDK reads `data.luid`; no sample has one; prefix unknown).
4. `source: {}` on credit entries (NS:410) vs. target only (AI:124).
5. Prepare timeout; which intent statuses allow abort.
6. Whether bridged wallets get ledger balance rows at all.
