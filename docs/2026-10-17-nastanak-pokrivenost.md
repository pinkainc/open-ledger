# S9, prvi dio: pokrivenost, pad u credit fazi, indeks threadova

Sesija 2026-10-17, od `3054926` do `7bcb763`. Nastavak je opet S9 (`docs/handoffs/S9.md`,
popis na vrhu). Prethodni pokušaj S9 (2026-10-16) prekinuo je tjedni limit nakon samo
dodavanja c8-a.

## Pokrivenost: 99,05 % linija `server/src`

`npm run coverage` (`scripts/coverage.sh`) vrti cijeli `scripts/check.sh` s dvije zamjene:
unit testovi i naš server pokreću se iz tsc builda u `.rec/covbuild`, s
`NODE_V8_COVERAGE`. c8 zatim spoji dumpove svih procesa (143 dumpa, 364 MB) i mapira ih na
`.ts`. Scenariji, proxy i bridge se ne mjere.

| Ukupno | Linije | Grane | Funkcije |
| --- | ---: | ---: | ---: |
| `server/src` | 99,05 % | 91,28 % | 98,92 % |

Brojke po datoteci su u `COVERAGE.md`, a izvor je `conformance/line-coverage.json`, koji
`coverage.ts` renderira kod svakog checka. Nikad pozvane funkcije: `Bridges.inOrder` i
`OAuth2Tokens.clear`.

### Zašto ne tsx i ne Nodeovo ugrađeno mjerenje

Mjereno na istom testu (`query.test.ts`) za `core.ts`:

| Način | Linije | Funkcije | Je li točno |
| --- | ---: | ---: | --- |
| c8 preko tsx-a | 99,4 % | 52,9 % | ne: `resume`, `enqueue` i druge nepozvane metode klase imaju 0 poziva, a linije im se broje kao pokrivene |
| `node --experimental-test-coverage` | 72,2 % | 48,7 % | ne: broji linije prevedenog koda (`status.ts` ima 82 linije, a prijavljuje do 53) |
| isto uz `--enable-source-maps` | 99,4 % | 48,3 % | ne, ista greška kao c8 preko tsx-a |
| **c8 nad tsc buildom** | **63,4 %** | **52,6 %** | da: nepozvane metode imaju 0 i na linijama |

tsx ostaje samo kao loader, jer obični Node ne razrješava direktorijske importe
`@minka/ledger-sdk/crypto`. Server sad izlazi na SIGTERM/SIGINT (`main.ts`), inače ga
`run.sh` ubije prije nego što zapiše V8 dump.

## Pad usred credit faze

Credit faza je jedna transakcija: oznaka `Store.once` i zapisi isporuka kredita.
`recovery.test.ts` simulira proces koji tu transakciju potvrdi, a umre prije slanja
(`deliver` za `/credits` ne radi ništa). Drugi `Core` na istoj bazi u `resume()` pošalje
isporuku koja je ostala `pending`, točno jednom i nepromijenjenu. Korak samog intenta ne
šalje je ponovo jer je oznaka postavljena.

Mutacijska provjera: kad je ključ oznake slučajan (oznaka nikad ne vrijedi), test pada s
„sent once: 2 ≠ 1”. Prvi pokušaj te provjere je visio: neuspjeli test ostavio je otvorene
servere, pa proces nije izašao. Čišćenje je sad u `t.after`.

## Indeks threadova

`Store.thread(ledger, thread)` zamjenjuje čitanje svih intenta ledgera. U Postgresu je
djelomični indeks `intents_by_thread` na `(ledger, (meta->>'thread')) where kind =
'intents'`. `explain` pokazuje `Index Scan using intents_by_thread`.

## Usput

- `docs/npm-run-check.md`: što check radi (replay snimki protiv lokalnog servera, bez
  staginga i bez LLM-a), s mermaid dijagramima.
- `docs/model.dbml`: logički model, 28 tablica i 9 obojenih grupa. drawDB uvozi iz DBML-a
  samo boju zaglavlja tablice (`headerColor`), a `TableGroup` ignorira, pa svaka tablica
  nosi boju svoje grupe.

## Otvoreno

Točka 3 (zaključavanje po walletu) počinje benchmarkom. Ledger lock danas implicitno čuva
i redni broj promjene (`changes.length + 1`), dnevne limite, oznake i threadove. Točke 5–7
su nepromijenjene. Sve je u `docs/handoffs/S9.md`.

Vezani dokumenti: `docs/2026-10-11-nastanak-snimke-i-cli.md` (S8), `docs/npm-run-check.md`.
