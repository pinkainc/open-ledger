# Landing page content inventory (W1)

Inventory for `open-ledger.mpt.hr`, English, claims in bullets. Not copy: W4 writes the
text, W2 generates the numbers. Every claim has a source `file:line` (checked
2026-10-24 at `6693756`). **[N]** marks a number that must come from `facts.json`.
Plan: `docs/2026-10-24-plan-landing.md`.

Source abbreviations: README = `README.md`, COV = `COVERAGE.md`, FIND = `FINDINGS.md`,
DIV = `conformance/divergences.json`, PLAN = `docs/2026-10-10-plan-do-paritete.md`,
BENCH = `docs/2026-10-19-nastanak-benchmark.md`.

## Contradictions and stale statements found (read first)

| # | Where | Says | Truth | How verified |
| --- | --- | --- | --- | --- |
| 1 | README:90 | "217 with Postgres" unit tests | **446** with Postgres; 252 on memory only (250 pass, 2 skipped) | `npm test` with and without `DATABASE_URL` (`scripts/dev-db.sh fresh`), `ℹ tests` line; matches PLAN:50 and TODO. The README is the one to fix (W8, or earlier by W2) |
| 2 | README:32-33 | divergences: "So far: one" | **21 entries across 14 fixtures** (13 distinct scenarios + the `.bridge.jsonl` companions) | `node -e` over `conformance/divergences.json`: length 21; distinct `fixture` after stripping `.bridge.jsonl` = 14 |
| 3 | COV:3 vs README:44-46 | spec 2.47.2 (COV) vs sandbox 2.47.9 (README) | both true: the spec mirror is 2.47.2, the sandbox and `SEMVER` are 2.47.9. Page must name both, not merge them | PLAN:52-54, `server/src/app.ts:64` |
| 4 | README:56 | L4 access "35/35 + 15/15 + 16/16 + 14/14" | matches fixture line counts (access 35, access2 15, access3 16, access4 14) | `wc -l conformance/fixtures/access*.reference.jsonl` |
| 5 | PLAN title in plan W1 | "Gdje smo" section | exists at `docs/2026-10-10-plan-do-paritete.md:47`, not a doc of its own | grep |
| 6 | COV:30-34 | line coverage 99.05 % measured 2026-10-17 at `3054926` | stale by 7 days and several commits; show only with its date, or do not show | `conformance/line-coverage.json` (`measured`, `commit`) |
| 7 | README:45 | "re-recorded on 2.47.5 (2026-10-19)" but PLAN:53 says most levels have 2.47.5 **and** 2.47.8 snapshots | the page's "recorded against" number is the sandbox version in `SEMVER` (2.47.9); per-level recording versions are not in `facts.json` sources | do not claim "all levels recorded on 2.47.9" |
| 8 | README:98 | level ladder lives in `../docs.minka.io/...` | a sibling repo outside this one: the page must not link to it | README:98 |
| 10 | README:134-135 vs BENCH:13 | ~450-530/s over 16 ledgers vs 398-446/s | unresolved, not re-measured (needs a load run); see section 8 | - |
| 9 | README (whole) | no contact address anywhere | footer contact is an open question for the user (plan "Otvoreno") | grep `contact` README.md: none |

## 1. Hero

- A Minka-compatible ledger: a server that answers the Minka Ledger API the way Minka does. (README:3-4)
- The official `@minka/ledger-sdk` and the `minka` CLI work against it unchanged. (README:3-4)
- The model is S3: Amazon's implementation is closed, its API is the contract, and MinIO, Ceph and R2 implement it with their own internals. (README:6-9)
- Minka is a black box in the same way; what is public is the API its clients speak. (README:7-8)
- Behind the API the design is ours and "free to be better than the original". (README:8-9)
- License MIT. (README:151, `package.json:5`, `LICENSE:1`)
- Buttons: GitHub `pinkainc/open-ledger` (plan, "Hero"); "Run locally" -> section 7; "How we measure compatibility" -> section 3.
- Numbers: none in the hero if possible; if a badge is wanted, use `operations.total` and `operations.confirmed`.

## 2. Numbers

- All **146 of 146** operations of Minka's spec implemented, every one confirmed by a recorded exchange. (README:43-44, COV:5)
- Spec the count is taken from: OpenAPI 2.47.2. (COV:3)
- Sandbox version last recorded against and reported by the server: 2.47.9. (README:44-46, `server/src/app.ts:64`)
- `surface` and `ledgers` re-recorded on 2.47.9, unchanged. (README:44-45, PLAN:52-54)
- Recorded exchanges: 3666 lines in `conformance/fixtures/*.jsonl` = 3123 client exchanges (`*.reference.jsonl`) + 543 bridge calls (`*.bridge.jsonl`). (counted, see below)
- 64 reference fixtures, 24 bridge fixtures, 65 files in `conformance/scenarios/` (counted).
- 446 unit tests with Postgres (252 on memory alone). (see contradiction 1)
- Every level passes on both the in-memory store and Postgres. (README:89)
- 16 API resources in the coverage table, led by signers 17, wallets 15, bridges 14, effects 14. (COV:9-24)
- Line coverage of `server/src`: 99.05 % lines, 91.28 % branches, 98.92 % functions, measured 2026-10-17 at `3054926`. (COV:34, `conformance/line-coverage.json`) -- stale-prone, show with date or leave out.
- Footprint on the sandbox: 271 ledgers created by recordings, listed in `conformance/footprint.jsonl` (README:123-125 says one ledger per run, undeletable). Optional "honest cost of measuring" figure.
- Missing: the plan asks for "number of recorded exchanges" but README gives only per-level counts. The total above is derived from fixtures, not stated anywhere. W2 must compute it.

## 3. How compatibility is proven

- Not by reading the docs and hoping: by recording the reference. (README:13)
- Flow: official SDK -> recording proxy -> Minka public sandbox gives `conformance/fixtures/*.reference.jsonl`; the same SDK -> proxy -> open-ledger gives `.rec/*.candidate.jsonl`; compare reports "N/N exchanges match". (README:15-19)
- Step 1: a scenario (`conformance/scenarios/l0.ts`) drives the official SDK so the requests are exactly what a real client sends. (README:21-22)
- Step 2: the proxy (`conformance/proxy.ts`) records every exchange verbatim. (README:23)
- Step 3: fixtures are recorded once against the sandbox, then our server is judged by `conformance/compare.ts`: status, body shape and every value must match. (README:24-26)
- Run-specific values (moments, luids, keys, hashes, signatures) become placeholders numbered by first appearance, so identity is still checked. (README:26-28)
- Error `detail` wording is compared but only reported. (README:28)
- Public register of deliberate divergences: `conformance/divergences.json`, each case with `what`, `reference`, `ours`, `why`; the comparator reports those exchanges instead of failing. (README:30-33, DIV)
- 21 entries today (contradiction 2). Example 1 (L3, exchanges 35-40): an issue taking bob above `maxBalance` stays `committed` forever on the reference; we reject it before preparing. Why: "an intent that can never reach a final status is a defect, not a contract". (DIV:3-12)
- Example 2 (L7, exchanges 25-27): a forward intent whose bridge never answers never expires on the reference (observed nine minutes); we expire it, abort the bridge part and release the reservation. (DIV:14-24)
- Docs mirror is the specification where the sandbox cannot show behaviour; where they disagree, the sandbox wins. (README:35-37)
- Two-phase commit: the scenario runs its own bridge, reached by the sandbox through a public quick tunnel, so the calls the reference makes to a bank are recorded (`fixtures/*.bridge.jsonl`). (README:37-39)
- Diagram (W5): SDK -> proxy -> {sandbox, open-ledger} -> compare, with the placeholder step and `divergences.json` as the exception list. Source: README:15-19.
- Numbers: `divergences.count`, `divergences.fixtures`, `fixtures.reference`, `fixtures.bridge`.

## 4. Levels L0-L9

Table from README:50-62, every cell a claim. Current values (all from README unless noted; fixture line counts verified for L0, L1, L3, access*, records*, L5, L6, routes, events, L9, l9mixed).

| Level | Scope | Minka operations | Conformance | Fixtures |
| --- | --- | --- | --- | --- |
| L0 | ledger, symbol, wallet: records only | 9 of 146 | 18/18 | `l0` |
| L1 | intents issue/transfer/destroy, balances, async | 12 of 146 | 30/30 | `l1` |
| L3 | limits, pagination, reads by luid | 13 of 146 | 39/41, 2 deliberately differ | `l3` (41 lines) |
| L4 (part) | record lifecycle, signers, ledger record, system policies | see COV | records 23/23, records2 52/52 | `records`, `records2` |
| L4 access | rule scope, ledger gate, matchers, circles, status policies, token impersonation, claim permissions | see COV | access 35/35, access2 15/15, access3 16/16, access4 14/14 | `access*` |
| L5 | 2PC with one bridge | bridges 8/14 | 21/21 client, 24/24 bridge | `l5` |
| L6 | several bridges in one intent, `claims.groupBy` | - | 34/34 client, 75/75 bridge | `l6` |
| Routes | addresses `schema:handle@parent`, wallet routes `credit`/`debit`/`accept`/`forward` | - | 62/62 client, 18/18 bridge | `routes` |
| L8 (bridges) | event deliveries: outbox, attempt proofs, 501 -> cancelled, retry, resume | bridges 11/14 | 23/23 client, 20/20 bridge | `events` |
| L7 (part) | intent expiry, also of intents waiting for a bridge | - | covered by access4 | - |
| L9 | two ledgers joined by `bridges/ledger-bridge` | - | `l9` 40/40 and 51/51; `l9mixed` 31/31 and 78/78 | `l9`, `l9mixed` |

- L2 (multi-claim atomicity) is covered by the L1 and L3 scenarios. (README:64)
- Problems: README:55-60 and 62 use "-" and "see COV" cells; "L7 (part)" claims coverage by access4 while FIND:847 has an L7 section and DIV has an `l7` entry (so L7 is also a fixture, `l7`, exchanges counted separately). W2 should generate the table from fixture line counts, not from README text. Rows in README are out of order (L8 before L7, Routes between L6 and L8): keep README order or sort by level, decide in W5.
- "N/N exchanges match" values should be computed by running compare in `--check` mode (or by `wc -l`), not copied.
- Numbers: one record per level in `facts.json` (`levels[]` with `id`, `scope`, `clientMatched`, `clientTotal`, `bridgeMatched`, `bridgeTotal`, `differ`).

## 5. Interoperability with Minka

- `bridges/ledger-bridge` joins two ledgers the way cross-ledger payments join a clearing house and a bank. (README:68-70)
- The clearing ledger sees it as the bridge of the bank's wallet; it carries every two-phase-commit call out as intents in the bank's own ledger. (README:70-72)
- It does not care whose ledger is on either side. (README:72)
- `conformance/scenarios/l9mixed.ts` runs it both ways against the public Minka sandbox. (README:72-73)
- Minka sandbox as clearing house and open-ledger as bank's ledger: top-up, payments in and out, a refused debit, an abort after a prepared debit; bank supply equals clearing position, **325 = 325**. (README:75-77)
- open-ledger as clearing house and Minka sandbox as bank's ledger: same flows, 325 = 325. (README:78)
- Minka calls the adapter through a tunnel and the adapter writes to our ledger with the official SDK; in the other direction our ledger calls the adapter and the adapter writes to Minka. (README:80-82)
- Both directions recorded; `npm run check` replays them against our server alone: **31/31** exchanges, **78/78** bridge log. (README:82-83, fixture `l9mixed` 31 and 78)
- The official `minka` CLI runs a whole flow against the server (connect, signer, ledger, symbol, wallets, issue, transfer, balances, filtered lists) in `scripts/cli-e2e.sh`, part of `npm run check`. (README:85-87)
- Link: https://docs.minka.io/ledger/connecting-systems/cross-ledger-payments (README:69). Fine as a link; nominative use only.
- Numbers: `interop.supply` (325), `interop.mixed.client` (31), `interop.mixed.bridge` (78). The 325 is a scenario constant, not computable from the fixture without parsing; W2 may hardcode it in the generator with a note, or parse the last balance exchange. Decide in W2.

## 6. API coverage (`/coverage` and a teaser)

- Generated by `npx tsx conformance/coverage.ts` from Minka's published OpenAPI spec 2.47.2. (COV:3)
- 146 of 146 implemented, 146 confirmed by a recorded exchange. (COV:5)
- Table of 16 resources with implemented/total and per-operation list with a check mark. (COV:7-24)
  Sizes: signers 17, wallets 15, bridges 14, effects 14, circles 13, anchors 10, policies 10, reports 9, domains 8, ledger 8, schemas 8, symbols 8, intents 7, ledgers 2, system 2, oauth 1 (sum 146).
- Check mark means a reference exchange is recorded in `conformance/fixtures/`. (COV:26)
- Also served, outside the spec: `GET /api/v2`, which `minka server connect` reads. (COV:28)
- Page reads `COVERAGE.md` at build time (W6), no copy. Operation strings contain backslashes (`access/\!check`) that must be unescaped when rendering. (COV:12 etc.)
- Numbers: `operations.total`, `operations.implemented`, `operations.confirmed`, `resources[]`.

## 7. Running it

- Requirements: Node >= 20. (`package.json:8`)
- `npm install`; `npm run check` (typecheck, tests, conformance, both stores); `npm run conformance:check -- l1`; `scripts/dev-db.sh start` (project-local Postgres on :5439, prints `DATABASE_URL`); `scripts/cli-e2e.sh` (CLI against a fresh server on :4640); `DATABASE_URL=... npm start` (server on :4620, memory store without `DATABASE_URL`). (README:102-109)
- `npm run conformance:record -- l1` re-records the reference and creates one sandbox ledger per run: do NOT put on the landing page as a first step (README:106, 123-125). Mention only that recording leaves a ledger on the public sandbox.
- Environment table: `DATABASE_URL`, `PORT` (4620), `PUBLIC_URL`, `SERVER_HANDLE`, `OPEN_LEDGER_MASTER_KEY` (32 bytes base64; without it a key per process and secrets are lost on restart, the server warns), `OPEN_LEDGER_DELIVERY_MAX_RETRIES` (5, as the reference), `OPEN_LEDGER_LOG`. (README:112-121)
- Official `minka` CLI and SDK against the local server: the README says they "work against it unchanged" (README:3-4) and shows the CLI e2e flow (README:85-87) but gives **no copy-paste CLI or SDK snippet**. Missing: a minimal `minka server connect` / SDK `baseUrl` example. W4/W5 must take one from `scripts/cli-e2e.sh` (grep `minka`), not invent it.
- Numbers: ports are constants (`ports.server` 4620, `ports.cli` 4640, `ports.pg` 5439), best read from `server/src/main.ts` and `scripts/*.sh`.

## 8. Design and limits

- Two stores: Postgres and in-memory; every level passes on both. (README:89, 109)
- Serialisation: intents of one ledger are processed one at a time (advisory lock in Postgres). (README:133-134)
- Measured with `scripts/bench.ts` on a local Postgres: ~200-240 transfers/s per ledger, ~450-530/s over 16 ledgers. (README:134-135)
  The benchmark doc gives finer ranges: 1 ledger 221-245/s, 4 ledgers 271-295/s, 16 ledgers 398-446/s (500 transfers, disjunct wallet pairs); memory, 1 ledger ~890/s. (BENCH:9-14)
  **Contradiction 10:** README says ~450-530/s over 16 ledgers, BENCH:13 says 398-446/s (before/after the pool fix). Which is current is unknown from the sources: W2 must not hardcode either; if shown, re-run `scripts/bench.ts` locally (no sandbox) and store the result with date, or show the README range with "measured on a laptop".
- Per-wallet locking was measured and dropped: a 2x ceiling does not pay for the risk. (README:135-136, BENCH:5, 18-21)
- Invariants checked by unit tests, which the reference cannot show from outside: conservation of supply over a random intent sequence compared against a model; no overdraft under 50 concurrent transfers; two processes sharing one Postgres; recovery of intents left pending by a crashed process. (README:90-93)
- Known gap 1: `hsh` needs the public address. The claim binds a token to method + absolute URL + body; behind a reverse proxy set `PUBLIC_URL` (the `.../api/v2` clients use) or every token with `hsh` is refused, as the reference refuses a token hashed over any other address. (README:129-132)
- Known gap 2: ledger-wide serialisation (above). (README:133)
- Backlog outside the claims: `schedule` and `layout` policies, in-flight runs of the `ledger-bridge` adapter, fewer round trips per intent, DTC executor if the sandbox ever executes it. (PLAN:62-65) Optional "roadmap" line.
- Daily limits: after a fix, `dailyCount` checks no longer grow with history (memory ~850/s flat; Postgres 210 -> 174/s). (BENCH:84-94) Optional.
- Numbers: `bench.perLedger`, `bench.sixteenLedgers` (see contradiction 10), `tests.total`, `tests.files` (32 files in `server/test/`), `server.sourceFiles` (22 in `server/src/`).
- Missing: no architecture overview in README (store, access, bridges, processing). A diagram of "request -> access -> intent processor -> store -> bridge deliveries" would need `server/src/*.ts` read in W5; no source here. W5 decides whether to omit.

## 9. What this is not

- An open-source ledger does not open a bank: licensing, capital, AML/KYC, sanctions screening and scheme access are the larger part of that problem. (README:140-142)
- It is a core banking substrate a licensed institution can run. (README:142-143)
- Minka's text, code and name are not copied. The API is implemented from observed behaviour and public documentation. (README:144-145)
- The CLI (UNLICENSED) is used as a client and its bundle was read to learn the token claims it sends; none of its code is reused. (README:145-146)
- The SDK (MIT) is a dev dependency of the conformance suite. (README:147, `package.json:11` `@minka/ledger-sdk`)
- Caution: README:145-146 says the CLI bundle "was read". Keep this sentence verbatim in the page's licensing note; do not paraphrase to something softer.

## 10. Findings (`/findings`)

- `FINDINGS.md` records the behaviour of the reference ledger (public sandbox `https://ldg-stg.one/api/v2`), each entry saying how it was established, newest first. (FIND:3-5)
- 40 dated sections, 1309 lines, 2026-09-26 to 2026-10-24 (counted: `grep -c '^## ' FINDINGS.md`, headings at FIND:7 ... 1248).
- Newest: "Filter context of processing policies per action (S11)" (FIND:7), "Labels corners (S11)" (FIND:29), "Filters on processing policies (S10)" (FIND:50), "Labels and labels policies (S10)" (FIND:63), "DTC policies (S10)" (FIND:94).
- Oldest: "L0" (FIND:1248), "L1" (FIND:1187), "L3 and the questions L1 left open" (FIND:1149), "Record lifecycle" (FIND:1116).
- Notable themes for a teaser: abort before the bridge confirms it (v2.47, FIND:739); two ledgers joined by a bridge (FIND:251); access inherited through domains (FIND:306); `hsh` and OAuth (FIND:516); reports protocol (FIND:468).
- The page's second half is `divergences.json` rendered as a table (`fixture`, `what`, `reference`, `ours`, `why`). (DIV)
- Service version in the heading of FINDINGS is stale ("2.45.5, 2.46.5, 2.47.4"; FIND:3-5) against 2.47.9 now; do not quote it, take the version from `SEMVER`.
- Findings text is English only (W6 decision in plan: may stay English with a note on `/hr/`).
- Numbers: `findings.sections`, `findings.firstDate`, `findings.lastDate`, `divergences.count`.

## 11. Footer

- License MIT, see `LICENSE` (copyright line: "Copyright (c) 2026 Matija Stepanic", `LICENSE:3`). (README:151)
- GitHub: `pinkainc/open-ledger` (plan; README has no URL; `git remote -v` confirms `git@github.com:pinkainc/open-ledger.git`).
- Disclaimer: "open-ledger is an independent project and is not affiliated with or endorsed by Minka Inc.; 'Minka' refers to their product only to name the API this server is compatible with." (README:151-153)
- Contact: missing in every source. Open question for the user (e-mail, GitHub issues, or both).
- Copyright holder in LICENSE is a natural person while the repo is under the `pinkainc` org: not a contradiction, but the page should not say "Pinka Inc. license" anywhere. Take the holder from `LICENSE` as is.

## 12. Technical requirements (checklist, not claims)

Decisions already made in the plan (PLAN-landing "Odluke" and "Što stranica mora imati" item 12): `<title>`/description per language, Open Graph image HR+EN, favicon, `sitemap.xml`, `robots.txt`, `hreflang`, `llms.txt`, light and dark theme, works at 360 px, WCAG AA, no external fonts or trackers. Nothing in the repo to source; facts for those files:

- `<title>` and description should use the hero claim (section 1) and the headline numbers (section 2).
- `llms.txt` should list: README, COVERAGE, FINDINGS, divergences, the repo URL.
- Canonical host `https://open-ledger.mpt.hr` (plan W7).
- No numbers.

## Popis brojki za W2

Each row: field name in `site/src/data/facts.json`, source and computation, current value on 2026-10-24 at `6693756`. "Counted" = verified in W1 by the command given.

| Field | Source and computation | Value now |
| --- | --- | --- |
| `generated.commit` | `git rev-parse --short HEAD` | `6693756` (will move) |
| `generated.date` | today, ISO; make it deterministic for `--check` (see note below) | - |
| `operations.total` | `COVERAGE.md:5` ("146 of 146"), or `conformance/coverage.ts` | 146 |
| `operations.implemented` | same line | 146 |
| `operations.confirmed` | same line ("146 of them confirmed") | 146 |
| `operations.spec` | `COVERAGE.md:3` (OpenAPI version) | `2.47.2` |
| `resources[]` | rows `COVERAGE.md:9-24`: `name`, `implemented`, `total` | 16 rows (sum 146) |
| `version.server` | `export const SEMVER` in `server/src/app.ts:64` | `2.47.9` |
| `version.sandbox` | same as `version.server` (the plan treats them as one) | `2.47.9` |
| `fixtures.reference` | count of `conformance/fixtures/*.reference.jsonl` | 64 |
| `fixtures.bridge` | count of `conformance/fixtures/*.bridge.jsonl` | 24 |
| `exchanges.client` | total lines in `*.reference.jsonl` (`cat ... \| wc -l`) | 3123 |
| `exchanges.bridge` | total lines in `*.bridge.jsonl` | 543 |
| `exchanges.total` | `client + bridge` (all `*.jsonl` = 3666) | 3666 |
| `scenarios.count` | `ls conformance/scenarios \| wc -l` (includes non-scenario helpers? check at W2: 65 files vs 64 reference fixtures) | 65 |
| `tests.postgres` | `node --test` on `server/test/**` with `DATABASE_URL` set to an empty DB: `ℹ tests` | 446 |
| `tests.memory` | same without `DATABASE_URL` | 252 (250 pass, 2 skipped) |
| `tests.files` | `ls server/test/*.ts \| wc -l` | 32 |
| `server.sourceFiles` | `ls server/src \| wc -l` | 22 |
| `divergences.count` | `conformance/divergences.json` length | 21 |
| `divergences.fixtures` | distinct `fixture` with `.bridge.jsonl` stripped | 14 |
| `findings.sections` | `grep -c '^## ' FINDINGS.md` | 40 |
| `findings.firstDate`, `lastDate` | the `YYYY-MM-DD` of the first and last `## ` headings | 2026-09-26, 2026-10-24 |
| `levels[]` | per README:50-62; counts from `wc -l` of the level's fixtures; `differ` from `divergences.json` entries on that fixture. L3: 41 total, 2 differ (DIV l3 exchanges 35-40 vs README's "2"), so compare must report differs, not `wc -l` alone | see section 4 |
| `interop.supply` | 325 (scenario constant, `l9mixed` and README:77, 78) | 325 |
| `interop.mixed.client`, `.bridge` | `wc -l` of `l9mixed.reference.jsonl`, `l9mixed.bridge.jsonl` | 31, 78 |
| `lineCoverage` | `conformance/line-coverage.json`: `total.lines/branches/functions`, `measured`, `commit` | 99.05 / 91.28 / 98.92, 2026-10-17, `3054926` |
| `footprint.ledgers` | lines in `conformance/footprint.jsonl` | 271 |
| `bench.*` | `scripts/bench.ts` output; **not computable at check time** (needs Postgres and seconds of load, and is noisy). Store as a dated constant with its source (`BENCH:9-14`), exclude from `--check` staleness | 1 ledger 221-245/s; 16 ledgers 398-446/s (BENCH) or 450-530/s (README) |
| `ports` | constants: 4620 server, 4640 cli e2e, 5439 dev Postgres | 4620, 4640, 5439 |
| `node.engine` | `package.json:8` | `>=20` |
| `license` | `package.json:5` | `MIT` |

Notes for W2:

- `--check` must be deterministic: no wall-clock timestamp in `facts.json` (or the check fails daily). Use the commit only if it is the commit of the last change to the inputs, otherwise it fails after every unrelated commit. Safer: leave the commit and date out of the file, or hash the inputs.
- Test counts need Postgres; `npm run check` already has `DATABASE_URL`. `--check` should read the count from `.rec/test.log` written by `scripts/check.sh` (line `ℹ tests N`) rather than run the suite twice, and fail with a clear message if the log is missing.
- Level counts: do not parse README text; count fixture lines. README:49-62 is then checked against `facts.json`, not the other way round.
- The README itself has stale numbers (contradictions 1, 2): W2's "done when" says to record README errors; fix them in W2 (small edit to README:90 and README:32-33), or list them for W8. This inventory recommends fixing in W2 since `facts.json` is what proves them wrong.
