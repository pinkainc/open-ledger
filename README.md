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
sandbox cannot show from outside: 2PC with banks, event delivery, expiry. Where docs
and sandbox disagree, the sandbox wins.

## Status

| Level | Scope | Minka operations | Conformance |
| --- | --- | --- | --- |
| **L0** | ledger, symbol, wallet — records only, no money moves | 9 of 146 | **18/18** exchanges match |
| **L1** | intents: issue, transfer, destroy; balances; async processing | 12 of 146 | **30/30** exchanges match |
| **L3** | limits (`minBalance`, `maxBalance`), pagination, reads by luid | 13 of 146 | **39/41** match, 2 deliberately differ |
| **L4** (part) | record lifecycle: update, status proofs, changes, drop, access check; signers, the ledger record, system policies | see `COVERAGE.md` | records **23/23**, records2 **52/52** |
| **L4** access | rule scope, ledger gate, matchers, circles, status policies, token impersonation, claim permissions | see `COVERAGE.md` | access **35/35**, access2 **15/15**, access3 **16/16**, access4 **14/14** |
| **L7** (part) | intent expiry | — | covered by access4 |

(L2, multi-claim atomicity, is covered by the L1 and L3 scenarios.)

Every level passes on the in-memory store and on Postgres. Beyond conformance, the unit
tests (`server/test/`, 148 with Postgres) check invariants the reference cannot show from
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
DATABASE_URL=… npm start            # server on :4620 (memory store without DATABASE_URL)
```

`record` leaves one ledger on the public sandbox per run; the sandbox cannot delete
ledgers. Ledgers are named `open-ledger-conf-<run>` so they stay identifiable. Record
only when a scenario changes.

## Known gaps

- **`hsh` claim is not verified.** It binds a token to method + absolute URL + body.
  Verifying it behind a reverse proxy needs the URL the client used (the same problem
  as `Host` in S3 SigV4 signatures). The recording proxy has the same issue, which is
  why the scenario sends tokens without `hsh`.
- **Access policies** (`{policy: handle}`, `access.strategy: policy-based`) are not
  evaluated; a rule naming a policy grants nothing.
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
