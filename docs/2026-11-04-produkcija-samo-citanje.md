# Je li projekt ikad dirao Minkin produkcijski ledger

Pregled 2026-11-04 nad svim Claude Code sesijama ovog repoa i `docs.minka.io` (38 sesija i
12 subagenata, 2026-08-06 → 2026-11-04) te nad svim fajlovima koje su sesije zapisale.

**Samo čitanjem. Produkcija je dirnuta 9 puta, sve GET, i to gotovo isključivo `GET /api/v2`
(handle, semver, status).** Jedina iznimka je provjera dostupnosti 2026-08-06 koja je tražila
samo HTTP status od `GET https://ledger.minka.io/api/v2/ledgers` i dobila `403`, bez podataka.

| kad | što | odgovor |
|---|---|---|
| 2026-08-06 | `GET ledger.minka.io/api/v2/ledgers`, samo status | 403 |
| 2026-10-02 | `GET ledger.minka.io/api/v2` | `prd 2.46.4 UP` |
| 2026-10-08 | `GET ldg.one/api/v2`, `GET ledger.minka.io/api/v2` | verzija |
| 2026-10-24 | `GET ldg.one/api/v2` (ručno i kroz `scripts/minka-version.sh`) | prazno, skripta piše „?” |
| 2026-10-30 | `GET ledger.minka.io/api/v2`, `scripts/minka-version.sh` | `2.47.17` |

Jedini kod u repou koji zna za produkcijski host je `scripts/minka-version.sh`, i on samo čita
semver. Sve što piše (ledgeri, signeri, intenti, snimke) išlo je na sandbox `https://ldg-stg.one`:
82 pokretanja `conformance/run.sh record` i `minka` CLI preko `server.json` koji pokazuje na
sandbox. Koliko je zahtjeva i ledgera tamo nastalo vodi [sandbox-footprint.md](sandbox-footprint.md).

## Zamka: `ldg.one` ne odgovara

`ldg.one/api/v2` je 2026-10-24 vratio prazan odgovor, pa `minka-version.sh` za produkciju ispisuje
`?`. Produkcijsku verziju zato čitaj s `https://ledger.minka.io/api/v2`. Skripta nije mijenjana.

## Kako je pregled napravljen

Privatna skripta izvan repoa (`~/.claude/scripts/session-audit/audit.py`) prolazi kroz svaki
`tool_use` u sesijama, razlikuje stvarni zahtjev od hosta koji se samo spominje (heredoc,
grep, ime GitHub repoa) i uz svaki produkcijski dodir sprema naredbu i početak odgovora.
Svih 9 dodira pročitano je i ručno. Izvještaj sadrži promptove pa nije u repou.

Vezani dokumenti: [sandbox-footprint.md](sandbox-footprint.md), `scripts/minka-version.sh`.
