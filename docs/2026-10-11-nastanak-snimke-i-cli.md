# Nastanak: domene, filteri, policyji, tajne, reporti i CLI — 2026-10-11, sesija S8

Nastavak [`2026-10-11-nastanak-2pc-i-signali.md`](2026-10-11-nastanak-2pc-i-signali.md).
Ponašanje reference je u [`FINDINGS.md`](../FINDINGS.md) (unos 2026-10-11, S8), plan u
[`2026-10-10-plan-do-paritete.md`](2026-10-10-plan-do-paritete.md).

## Snimke

Svi preostali `(?)` iz `TODO.md` skupljeni su u scenarije i snimljeni na 2.47.4. Gdje je
snimka otvorila novo pitanje, snimljen je nastavak.

| Scenarij | Pitanja | Rezultat |
| --- | --- | --- |
| `domains3` | update poddomene, `meta.domains` (redoslijed, forward intent), `resolutionFromHandleEnabled: false` | 43/43 |
| `filters`, `filters2` | koja polja lista podržava po vrsti recorda; što je `$regex` | 286/298 + 12 namjerno; 18/18 |
| `policies3`, `policies4` | policy u domeni, `filter`, `invoke`, liste u policy-based ledgeru | 56/56; 43/43 |
| `auth2` | redoslijed provjere u `/oauth/token`, `target.schema`, tko smije `include=meta.secret`, vanjski IdP | 30/30 |
| `reports3`–`reports5` | putanja asseta (ledger, domena, shema, luid), status policy na reportima, `report-dropped` | 53/58 + 5 namjerno; 32/35 + 3; 17/17 + 1/1 |
| `cli` | isti `minka` tok protiv sandboxa i nas, `bridge events list/show/retry` | 63/64 + 1 namjerno; 2/2 |
| `daywindow` | dnevni prozor limita (klizni ili UTC dan), `destroy` i `dailyAmount` | vidi niže |

Najveće iznenađenje su policyji. Policy u domeni vrijedi samo za recorde te domene.
`filter` je relativan na `data` i ima popis dopuštenih ključeva po vrsti recorda. Liste u
policy-based ledgeru pokazuju samo ono što daje vrijednost s `query` ili `any`, pa `read`
nije dovoljan. `intent.canSpendEveryClaimWallet` gleda samo izvore, iako docs kažu i
odredišta. Drugo iznenađenje je da `$regex` u listi nije regularni izraz nego `LIKE`
podniza.

## Što se promijenilo u serveru

- `app.ts`: poddomena pri updateu zadržava `domain`; `meta.domains` je sortiran; nova
  provjera filtera liste (`unsupportedFilters` u `query.ts`); ključevi izvan `data.` i
  `meta.` se ignoriraju; `$regex` u listi je `$like`; OAuth prvo provjerava vjerodajnice;
  report sa status policyjem mora smjeti `created`; `report-dropped` nosi `parent`.
- `core.ts`: forward intent dobiva `access` prvog intenta i domene svojih walleta.
- `access.ts`: policy u domeni, `filter` i `invoke` u vrijednostima, `listable` za liste
  u policy-based ledgeru, `authorizeReveal` za tajne.
- `schemas.ts`: zajednički oblik greške za grane `policy-data` (`policyInvalid`),
  vrijednost status policyja traži `quorum`, `action` u access vrijednosti je jedan string.
- `reports.ts`: putanja asseta se uspoređuje s reportom.

## Alat

- `conformance/cli-flow.sh` i scenarij `cli`: CLI kao razina conformancea. Operatorov ključ
  uvozi se kao PEM (`minka signer create -i`), pa ledger stvara isti ključ kao u ostalim
  snimkama. Scenarij pokreće skriptu asinkrono jer bridge odgovara iz istog procesa
  (`spawnSync` je blokirao event loop).
- `tools/minka-seq.exp`: `@CHECK<n>` označi prvih n stavki checkbox prompta (traitovi
  bridgea).
- `own-ledger.ts` zadržava `GET /api/v2`: CLI ga šalje bez ledgera i bez oznake runa.
- `compare.ts`: `meta.domains` se uspoređuje kao skup.
- `run.sh`: scenarij s `// day-boundary` dobiva `DAY_BOUNDARY`. Kod snimanja je to sljedeća
  UTC ponoć, a kod checka točka 40 s unaprijed, koju dobiva i naš server
  (`OPEN_LEDGER_DAY_BOUNDARY_MS`).
- `common.ts`: `scenario({config})` za dodatnu konfiguraciju ledgera.
