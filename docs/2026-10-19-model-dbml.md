# Model u DBML-u: provjera prema kodu i odluke (2026-10-19)

`docs/model.dbml` je logički model Minka zapisa kako ih open-ledger poslužuje, uz fizičku
Postgres shemu (`pg.*`). Prva verzija (`30b77f8`) nastala je iz OpenAPI-ja. Druga verzija
(`bd59710`) je provjerena prema `server/src`. Ovaj dokument bilježi ono što se iz samog
modela ne vidi.

## Što je u prvoj verziji bilo krivo

| Tvrdnja v1 | Stvarno (izvor) |
| --- | --- |
| `wallets.parent → wallets` i `parent` kao roditeljski zapis | `data.parent` je hash verzije koja se zamjenjuje, obavezan na update i drop (`app.ts`, `parentHashInvalid`; OpenAPI `base-data`) |
| Postgres ima samo `records` + 3 pomoćne tablice | Postgres ima i `balances`, `limits` i `changes` (`pg-store.ts` SCHEMA) |
| `intents_by_thread` na `(ledger, kind)` | Indeks je na `(ledger, (meta->>'thread')) where kind = 'intents'` |
| signer factor `oauth-credentials` | Shema se zove `oauth-client-credentials` (`schemas.ts`), a postoji i `otp` |
| statusi intenta s „…“ na kraju | Zatvoren skup: `pending, prepared, committed, completed, aborted, rejected` na `meta.status`. Trag proofova ima širi skup (`created, resolved, failed, error` …) |

Pouka: model izveden samo iz OpenAPI-ja izgleda uvjerljivo, ali `parent` i fizičku shemu
ispravio je tek kod.

## Odluke

- **drawDB kompatibilnost je napuštena** (korisnik, 2026-10-19). Model koristi DBML 10.x:
  `TablePartial`, `Dep`, `checks`, `records`, `DiagramView` i vlastita svojstva
  (`luid_prefix`, `api`). Čitaju ga open-diagram i dbdiagram.io.
- **`meta` polja imaju imena u navodnicima** (`"meta.status"`), a `data` polja su obična.
  Tako se na platnu vidi oblik zapisa na žici.
- **Refovi na `ledger` i `schema` su namjerno izostavljeni.** Svaka logička tablica ima
  ih, pa bi platno bilo zatrpano linijama. `"meta.domain"` je nacrtan samo za `wallets`.
- **`intent_entries` se nigdje ne sprema kao zaseban zapis.** To su `resolved` proofovi
  u tragu intenta. Nacrtani su kao tablica jer su karika claim → balance → bridge.
- **`records` blokovi su top-level bez `[example]`.** Parser 10.3.1 dopušta `[example]`
  samo unutar tablice, a top-level oblik traži popis stupaca.
- **Enum ne smije imati `[note: …]`** (parser: „An Enum shouldn't have a setting list“).
  Opis enuma ide u komentar iznad njega, a bilješke na vrijednosti su dopuštene.

## Jedan model ili više manjih

Preporuka je jedan `model.dbml` s pogledima (`DiagramView`) za podsustave: novac,
pristup, integracija, fizička shema. Zasebne datoteke s `use` uvozom open-diagram ne
može otvoriti, a dvije kopije istih tablica bi se razišle.

Ponašanje (2PC tijek intenta, razrješavanje adrese i ruta, provjera pristupa) DBML ne
prikazuje. To ide u Markdown s Mermaidom (`stateDiagram`, `sequenceDiagram`,
`flowchart`). Bilješke na platnu modela su samo sažetci tih tokova.

## Što open-diagram još ne prikazuje (stanje 2026-10-19)

Parser sve navedeno pročita, ali renderer ne crta: `Dep` lineage (50 bridova), opcionalne
refove `>?` i `inactive`, `DiagramView`, bilješku projekta s Markdownom, `checks` i
vlastita svojstva. Sticky bilješke su sve ispale žute iako svaka ima svoju boju (vidi
`test-output/layout-compact.png`). Brojke modela: 35 tablica, 400 polja, 35 refova,
27 enuma, 9 grupa, 7 bilješki, 31 `Dep` (50 bridova), 4 `checks`, 5 `records`.

## Provjera

```bash
# parse + render + preklapanja u headless Chromeu (24 provjere)
cd ~/git/stepanic/open-diagram && npm test -- ~/git/minka/open-ledger/docs/model.dbml
```

`examples/open-ledger.dbml` u open-diagramu mora ostati bajt-identičan `docs/model.dbml`.

Vezani dokumenti: [nastanak pokrivenosti](2026-10-17-nastanak-pokrivenost.md) (prva
verzija modela), [npm run check](npm-run-check.md).
