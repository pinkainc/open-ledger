# Plan do pune paritete s Minkom (2026-10-10)

Ovo je plan za buduće Claude Code sesije. Cilj je da open-ledger pokrije cijeli Minkin
klijentski API (146 operacija iz `../docs.minka.io/_raw/openapi.yaml`), da se za isti
ulaz ponaša jednako kao referenca i da svako ponašanje ima test. Svaka sesija je jedan
paket. Završava se zelenim `npm run check`, commitom, pushem i `/wrap-up` handoffom
koji imenuje sljedeći paket iz ove tablice.

Handoff promptovi za sve sesije su u `docs/handoffs/` (`S1.md` … `S11.md`). Pravila lanca
su u `docs/handoffs/README.md`: sesija N smije prepraviti `S(N+1).md` ako je naučila
nešto što mijenja sljedeći paket.

## Polazno stanje (commit `90abe6d`)

| Mjera | Stanje |
| --- | --- |
| Operacije | 122/146 (84 %), 91 potvrđena snimkom (62 %) |
| `TODO.md` | 96 gotovo, 42 otvoreno: 15 stvarnog rada, 24 `(?)` snimke, 3 zastarjele (počišćeno uz ovaj plan) |
| Testovi | 22 unit datoteke, 23 conformance scenarija na memory i Postgresu, `minka` CLI e2e |

## Brzina, iz dosadašnjeg rada

- Dosad je bilo oko 7 sesija: L0–L8, rute, effecti, sheme, anchori i domene.
- Zadnja sesija (9. 10. navečer) zatvorila je pet snimljenih paketa za otprilike sat
  vremena: korisničke sheme, dropove, anchore, anchore preko bridgea i domene. Taj
  tempo vrijedi kad je ponašanje usko i dobro opisano u docsima.
- Paketi s novim protokolom prema vanjskom sustavu traju cijelu sesiju. Primjeri su
  L5 bridgeovi i effecti. Reports, cross-ledger i anchor forwarding su takvi.
- Kontekst je stvarni limit. Oko 150k tokena treba napraviti `/wrap-up`, pa sesija
  realno nosi jedan velik ili tri do pet malih paketa.

## Plan po sesijama

| # | Paket | Sadržaj | Operacije | Gotovo kad |
| --- | --- | --- | --- | --- |
| **S1** | Pristup i limiti | Access policies (`{policy: handle}`, `access.strategy: policy-based`, migracija strategije); dnevni limiti `dailyAmount` i `dailyCount` uz `limits.aggregated.enabled`; limit na walletu bez salda `(?)`; dozvole prije ili poslije limita `(?)`; `destroy` traži i `spend` `(?)` | — | scenariji `policies` i `limits2` snimljeni i jednaki |
| **S2** | Autentikacija | Signer factors (9 operacija) i tajne factora; `POST /oauth/token`; provjera claima `hsh` (`PUBLIC_URL`); OAuth2 cache tokena za bridgeove | +10 | 132/146; scenarij `factors` snimljen |
| **S3** | Reports | `$rep` record (9 operacija), report sheme (`record: report`), status izvještaja, reporting bridge protokol po `reporting/*.md` | +9 | 141/146; scenarij `reports` sa snimkom bridge poziva |
| **S4** | Ledger i sustav | `GET /ledgers` (usporedba koja zanemaruje tuđe ledgere), `POST /ledger`, `DELETE /ledger`, `GET /system/requests[/{id}]`; sheme `extend`; generička `secure` pravila (mtls); autorizacija bridge proofova | +5 | **146/146** |
| **S5** | Usmjeravanje i domene | Anchor forwarding (processing policies: proxy, fallback, validate, synchronize); nasljeđivanje pristupa preko domena; `(?)` iz Routes (dubina > 3, ciklus debita, nerazriješen cilj, lookup bez bridgea, `secure` na anchor pozivima, potpis liste); DTC policy (prvo utvrditi opseg) | — | scenariji `forwarding` i `domains2` snimljeni |
| **S6** | L9 cross-ledger | Dva ledgera spojena bridgeom po `connecting-systems/cross-ledger-payments.md`. Snimka na sandboxu s dva ledgera, zatim test dvije naše instance, i miješano: naš ledger ↔ Minka | — | scenarij `l9` snimljen; e2e dvije instance |
| **S7** | Snimke `(?)`, prvi dio | 2PC i signali: kasni `prepared` nakon aborta, debit koji padne dok drugi čeka, rekoncilijacija nepotvrđenog commita, `*-proofs-added`, bridge-entry-*, wallet-limited, `intent-updated` bridgeanog i odbijenog intenta, više kredita istom walletu, bulk retry s `cancelled`, effect na nedostupan webhook, nastavak intenta nakon potpisa koji je nedostajao | — | svaki `(?)` iz L4, L6 i L8 riješen snimkom ili upisan u `divergences.json` |
| **S8** | Snimke `(?)`, drugi dio, i CLI | Domene `(?)` (update poddomene, `meta.domains` forwarda, `resolutionFromHandleEnabled`), drop walleta s anchorima, drop financiranog walleta, nepodržani filteri (`api.query-malformed`); CLI tok kao conformance razina; `minka bridge events` e2e | — | 0 otvorenih `(?)` u `TODO.md` |
| **S9** | Testna pokrivenost i jezgra | Mjerenje pokrivenosti (`node --test --experimental-test-coverage` ili c8), cilj ≥ 90 % linija u `server/src`; test pada usred credit faze; zaključavanje po walletu; indeks threadova po `meta.thread`; ponovno snimanje svih razina na zadnjoj verziji sandboxa; svaka operacija potvrđena snimkom | — | 146/146 potvrđeno snimkom; pokrivenost u `COVERAGE.md` |
| S10–S11 | DTC, labels, rezerva | **DTC policy** (premješten iz S5: `schema: dtc`, konfigurabilni 2PC koraci `dtc.prepare/commit/notify/setStatus` i `core.commit`, prioritet, filter po koraku, `suspendTimeoutMs`; u specu od 2.46, docs bez proze, SDK 2.47 ima tipove). Minka izlazi često: v2.47 je promijenio otpuštanje rezervacija i trebalo je ponovno snimiti l5–l7. Uz to idu iznenađenja iz snimki S3 i S6. **Pregled TODO-a 2026-10-11** dodao je u S10: labels (`meta.labels` preko proofa) i labels policies (docs postoje, kod ih ne primjenjuje), `filter` na processing policyjima, snimku `allowClientCredentials` i agregate dnevnih limita. `schedule` i `layout` policyji ostaju backlog izvan lanca | — | S10: DTC i labels snimljeni i jednaki |

**Procjena: 9 planiranih sesija, s rezervom 9–11 handoff promptova.** Najrizičniji
su S3 i S6. Reports i cross-ledger imaju vlastiti protokol, a docs su dosad u više
točaka bili netočni (npr. trait `effects`, a ne `events`). Ako se pokaže da reporting
bridge treba BigQuery ili nešto izvan klijentskog API-ja, taj dio ide u
`divergences.json`, a ne u plan.

## Što „identično” ovdje znači

- Za isti ulaz klijent dobiva isti izlaz: status, tijelo i potpisi u istom obliku.
  `compare.ts` to provjerava po scenariju.
- Namjerna odstupanja ostaju i dokumentirana su u `conformance/divergences.json`:
  ograničenje threada prije forwarda, `maxBalance` prije prepare, istek forward intenta.
  Ondje gdje referenca ima bug, ne kopiramo ga.
- Unutrašnjost je naša: Postgres, outbox, zaključavanje. Paritet se mjeri samo na
  API-ju, a ne na načinu kako je izveden.

## Pravila koja vrijede za svaku sesiju

Ista kao u dosadašnjim handoffima, ukratko:

- Ponašanje se snima, ne pogađa. Prvo napiši scenarij, probno ga pusti protiv našeg
  servera, onda `conformance/run.sh record`. Implementiraj i testiraj paralelno.
  `compare.ts` mora reći da se sve podudara.
- Nijedan slučaj ne smije napraviti neograničen posao na sandboxu. Pravilo je nastalo
  nakon 5000 intenata od 2. 10.
- Snimku i check nikad ne pokreći istovremeno.
- Svaki zeleni korak se commita i pusha. Uz to se održavaju `TODO.md`, `FINDINGS.md`,
  `COVERAGE.md` i dokument sesije.
- Bez Monitora koji javlja napredak. Duge jobove pokreni s `run_in_background` i javi
  se tek na kraju.
