# open-ledger

A Minka-compatible ledger: a server that answers the Minka Ledger API the way Minka
does, so the official `@minka/ledger-sdk` and `minka` CLI work against it unchanged.

The model is S3. Amazon's implementation is closed, but its API is the contract, and
MinIO, Ceph and R2 implement that contract with their own internals. Minka is a black
box in the same way: what is public is the API its clients speak. Everything behind
that API here is our own design and is free to be better than the original.

## How compatibility is established

Not by reading the docs and hoping. By recording the reference.

```
official SDK ──► recording proxy ──► Minka public sandbox   → conformance/fixtures/*.reference.jsonl
official SDK ──► recording proxy ──► open-ledger             → .rec/*.candidate.jsonl
                                                               compare → N/N exchanges match
```

1. A scenario (`conformance/scenarios/l0.ts`) drives the **official SDK**, so the
   requests are exactly what a real Minka client sends.
2. The proxy (`conformance/proxy.ts`) records every exchange verbatim.
3. Recorded once against the sandbox, the exchanges become fixtures. Our server is
   then judged against them (`conformance/compare.ts`): status, body shape and every
   value must match, after run-specific values (moments, luids, keys, hashes,
   signatures) are replaced by placeholders numbered by first appearance — so identity
   is still checked. Error `detail` wording is compared but only reported.

Where the reference is plainly defective we answer differently on purpose, and say so:
`conformance/divergences.json` lists each case with what the reference does, what we do
and why; the comparator reports those exchanges instead of failing on them. So far:
one (an intent breaking `maxBalance` stays `committed` forever on the reference).

Documentation (the mirror in `../docs.minka.io`) is the specification for what the
sandbox cannot show from outside. Where docs and sandbox disagree, the sandbox wins —
and more can be shown than it seems: for 2PC the scenario runs its own bridge, which
the sandbox reaches through a public quick tunnel, so the calls the reference makes to
a bank are recorded too (`fixtures/*.bridge.jsonl`).

## Status

| Level | Scope | Minka operations | Conformance |
| --- | --- | --- | --- |
| **L0** | ledger, symbol, wallet — records only, no money moves | 9 of 146 | **18/18** exchanges match |
| **L1** | intents: issue, transfer, destroy; balances; async processing | 12 of 146 | **30/30** exchanges match |
| **L3** | limits (`minBalance`, `maxBalance`), pagination, reads by luid | 13 of 146 | **39/41** match, 2 deliberately differ |
| **L4** (part) | record lifecycle: update, status proofs, changes, drop, access check; signers, the ledger record, system policies | see `COVERAGE.md` | records **23/23**, records2 **52/52** |
| **L4** access | rule scope, ledger gate, matchers, circles, status policies, token impersonation, claim permissions | see `COVERAGE.md` | access **35/35**, access2 **15/15**, access3 **16/16**, access4 **14/14** |
| **L5** | 2PC with one bridge: prepare/commit/abort calls, status notifications, retries, restart | bridges 8/14 | **21/21** client exchanges, **24/24** bridge calls |
| **L6** | several bridges in one intent: two-phase prepare, grouping (`claims.groupBy`), aborts only to prepared parts, silent bridges | — | **34/34** client exchanges, **75/75** bridge calls |
| **Routes** | addresses `schema:handle@parent`, wallet routes `credit`, `debit`, `accept`, `forward` | — | **62/62** client exchanges, **18/18** bridge calls |
| **L8** (bridges) | event deliveries: outbox, attempt proofs, 501 → cancelled, retry, resume | bridges 11/14 | **23/23** client exchanges, **20/20** bridge calls |
| **L7** (part) | intent expiry (also of intents waiting for a bridge) | — | covered by access4 |
| **L9** | two ledgers joined by a bridge (`bridges/ledger-bridge`): cross-ledger payments | — | `l9` **40/40** client exchanges, **51/51** bridge log; `l9mixed` **31/31**, **78/78** |

(L2, multi-claim atomicity, is covered by the L1 and L3 scenarios.)

### Interoperability with Minka itself

`bridges/ledger-bridge` joins two ledgers the way
[cross-ledger payments](https://docs.minka.io/ledger/connecting-systems/cross-ledger-payments)
joins a clearing house and a bank: the clearing ledger sees it as the bridge of the bank's
wallet, and it carries every two-phase-commit call out as intents in the bank's own
ledger. It does not care whose ledger is on either side. `conformance/scenarios/l9mixed.ts`
runs it both ways against the public Minka sandbox:

| Clearing house | Bank's ledger | Result |
| --- | --- | --- |
| Minka sandbox | open-ledger | top-up, payments in and out, a refused debit, an abort after a prepared debit; the bank's supply equals its clearing position (325 = 325) |
| open-ledger | Minka sandbox | the same flows; 325 = 325 |

Minka calls our adapter through a tunnel, and the adapter writes to our ledger with the
official SDK. In the other direction our ledger calls the adapter, and the adapter writes to
Minka. Both directions are recorded, and `npm run check` replays them against our server
alone (31/31 exchanges, 78/78 bridge log).

The official `minka` CLI runs a whole flow against the server — connect, signer, ledger,
symbol, wallets, issue, transfer, balances, filtered lists — in `scripts/cli-e2e.sh`,
part of `npm run check`.

Every level passes on the in-memory store and on Postgres. Beyond conformance, the unit
tests (`server/test/`, 217 with Postgres) check invariants the reference cannot show from
outside: conservation of supply over a random intent sequence compared against a
model, no overdraft under 50 concurrent transfers, two processes sharing one
Postgres, and recovery of intents left pending by a crashed process.

Work in progress is tracked in `TODO.md`; reference behaviour in `FINDINGS.md`.


The level ladder (L0–L9) is in `../docs.minka.io/ssot/2026-08-08-state-machine-model.md`.

## Run

```bash
npm install
npm run check                       # everything: typecheck, tests, conformance, both stores
npm run conformance:check -- l1     # one level against our server
npm run conformance:record -- l1    # re-record the reference (creates one sandbox ledger)
scripts/dev-db.sh start             # project-local Postgres on :5439, prints DATABASE_URL
scripts/cli-e2e.sh                  # the minka CLI end to end against a fresh server on :4640
DATABASE_URL=… npm start            # server on :4620 (memory store without DATABASE_URL)
```

Settings (environment):

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres; memory store without it |
| `PORT` | listen port (4620) |
| `PUBLIC_URL`, `SERVER_HANDLE` | what `GET /api/v2` reports, behind a proxy |
| `OPEN_LEDGER_MASTER_KEY` | 32 bytes, base64: seals the secrets bridge `secure` rules refer to. Without it a key per process (secrets are lost on restart; the server warns) |
| `OPEN_LEDGER_DELIVERY_MAX_RETRIES` | retries of a call to a bridge before it is cancelled (5, as the reference) |
| `OPEN_LEDGER_LOG` | one line per request on stderr |

`record` leaves one ledger on the public sandbox per run; the sandbox cannot delete
ledgers. Ledgers are named `open-ledger-conf-<run>` so they stay identifiable. Record
only when a scenario changes.

## Known gaps

- **`hsh` needs the public address.** The claim binds a token to method + absolute
  URL + body, as the client saw them. Behind a reverse proxy set `PUBLIC_URL` (the
  `…/api/v2` clients use), or every token with `hsh` is refused, as the reference
  refuses a token hashed over any address but its own.
- **Ledger-wide serialisation.** Intents of one ledger are processed one at a time
  (advisory lock in Postgres). Correct, and far above the reference's ~100 intents/s,
  but per-wallet locking would scale further.

## Non-goals

An open-source ledger does not open a bank: licensing, capital, AML/KYC, sanctions
screening and scheme access are the larger part of that problem. This is a core
banking substrate a licensed institution can run.

Minka's text, code and name are not copied. The API is implemented from observed
behaviour and public documentation. The CLI (UNLICENSED) is used as a client and its
bundle was read to learn the token claims it sends; none of its code is reused.
The SDK (MIT) is a dev dependency of the conformance suite.

## License

MIT, see [LICENSE](LICENSE). open-ledger is an independent project and is not
affiliated with or endorsed by Minka Inc.; "Minka" refers to their product only to
name the API this server is compatible with.
