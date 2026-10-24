# Provjera nove verzije Minke

Lanac S1–S11 je zatvoren 2026-10-24 na sandboxu **2.47.9** (spec 2.47.2, npm SDK i CLI 2.47.0).
Ovaj dokument je postupak za svaku kasniju provjeru. Ujedno je i handoff prompt: nakon `/clear`
dovoljno je reći „provjeri novu verziju Minke” ili zalijepiti ovaj fajl.

Zajednička pravila iz `docs/handoffs/README.md` vrijede i ovdje: snimka i check nikad
istovremeno, footprint commitati nakon svakog snimanja, nikad snimati petlje, soft limit 300k.

## 1. Je li se išta pomaknulo (samo čitanje, bez snimanja)

```bash
git pull
scripts/minka-version.sh
```

Skripta uspoređuje `SEMVER` s `GET /api/v2` na sandboxu i produkciji, docs mirror s
`docs.minka.io/openapi.yaml` i mirror s npm-om. Redak s `!` znači da se nešto promijenilo.
Ako je izlaz `0` („Ništa novo”), **tu je kraj**: ništa se ne snima i ne commita.

## 2. Ako se pomaknulo: odredi vrstu promjene

| Što se pomaknulo | Što to obično znači | Postupak |
| --- | --- | --- |
| Samo sandbox, patch (npr. 2.47.9 → 2.47.12) | Bugfix bez docsa. Dosad (2.47.5 → 2.47.9) nije mijenjao ponašanje | **A** |
| Spec ili minor (npr. 2.48.x) | Nove operacije ili polja. Release notes znaju biti prazni | **B** |
| npm SDK ili CLI | Tipovi i CLI sustižu spec | **B**, bez dodatnog snimanja ako spec stoji |

**A. Patch na sandboxu**

1. `npm run check` u pozadini (`run_in_background`, bez Monitora, traje više od 10 minuta).
   Mora biti zelen prije snimanja.
2. Snimi kanarince, jedan po jedan i nikad uz check: `surface`, `ledgers`, `l1`, `l5`, `dtc`.
   Naredba je `conformance/run.sh record <razina>`. `dtc` pokazuje izvršava li sandbox
   sada DTC korake (do 2.47.9 nije).
3. Ako `compare.ts` kaže da je sve jednako, podigni `SEMVER` u `server/src/app.ts`, commitaj
   fixturese i oba footprint fajla (`conformance/footprint.jsonl`, `docs/sandbox-footprint.md`)
   i osvježi „Verzija” u „Gdje smo” u `docs/2026-10-10-plan-do-paritete.md`.
4. Ako se nešto razlikuje, to je nalaz: zapiši ga u `TODO.md` i prijeđi na B za taj dio.

**B. Promjena speca ili minor verzija**

1. U `../docs.minka.io` pokreni `./sync.sh` i `./tools/npm-sync.sh`, a zatim `git diff --stat`.
   `diff` je u ovom shellu alias za git diff, pa za direktorije koristi `/usr/bin/diff -r`.
   Promjene zapiši u `ssot/<datum>-upstream-refresh-v<verzija>.md` (format kao prethodni).
2. Razlika u `_raw/openapi.yaml` je stvarni popis promjena. Release notes ne treba vjerovati.
3. Ako se pojavila nova operacija, ukupan broj više nije 146. Popravi pokrivenost
   (`npx tsx conformance/coverage.ts`) i `TODO.md`.
4. Posao procijeni po veličini:
   - mala promjena: napravi je u istoj sesiji (scenarij → check → record → implementacija
     → unit testovi), pa A.3;
   - velika promjena: otvori nastavak lanca `S12.md`, `S13.md` … po pravilima iz
     `docs/handoffs/README.md` i dodaj redove u „Stanje lanca”.
5. Ako se mijenja npm SDK, podigni `@minka/ledger-sdk` u `package.json`. Unit testovi
   pokreću upravo taj SDK.

## 3. Zapis

Svaka provjera nakon koje se nešto promijenilo dopisuje red u tablicu ispod, bez obzira na
ishod. Provjera bez promjene ne ostavlja trag.

| Datum | Sandbox | Spec | npm | Ishod |
| --- | --- | --- | --- | --- |
| 2026-10-24 | 2.47.9 | 2.47.2 | 2.47.0 | Polazište nakon zatvaranja lanca |
