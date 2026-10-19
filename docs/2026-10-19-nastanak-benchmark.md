# S9, točka 3: benchmark i zaključavanje po walletu (2026-10-19)

## Odluka

Zaključavanje po walletu **se ne radi**. Lock za cijeli ledger ostaje. Brojke su iz
`scripts/bench.ts` na lokalnom Postgresu (`scripts/dev-db.sh fresh bench`): 500 transfera
između disjunktnih parova walleta, poslanih odjednom.

| raspodjela | prihvat | ukupno | transfera/s |
| --- | --- | --- | --- |
| 1 ledger (prije popravka poola) | 1,7–1,9 s | 2,0–2,3 s | 221–245 |
| 4 ledgera | 1,0–1,2 s | 1,7–1,8 s | 271–295 |
| 16 ledgera | 0,45–0,53 s | 1,1–1,3 s | 398–446 |
| memorija, 1 ledger (200) | | 0,22 s | ~890 |

Ledger je već sam po sebi lock. Isti transferi raspoređeni na L ledgera zato pokazuju
**gornju granicu** dobitka od zaključavanja po walletu, bez ijedne promjene u serveru.
Ta granica je otprilike 2×, i to tek uz 16 neovisnih tokova. Lock za cijeli ledger danas
implicitno čuva i redoslijed promjena (`changes.length + 1`), dnevne limite (čitaju sve
intente ledgera), oznake i threadove. Walleti se razrješavaju tek unutar koraka (rute,
anchori). Dvostruki dobitak ne opravdava taj rizik u ledgeru.

## Gdje odlazi vrijeme

Jedan intent je **jedna transakcija** koja drži lock **~5 ms**. To je točno strop od
~200 intenta/s po ledgeru. U njoj je oko 40 upita od po ~0,1 ms (lokalni Postgres):
10 čitanja zapisa po handleu, 6 inserta u `changes`, 9 listi `effects` (po jedna za svaki
podignuti signal), te ključevi, salda, limiti i oznake. Nijedan od tih upita ne raste
s brojem intenta u ledgeru. Ako ikad bude potrebna veća propusnost, jeftinija poluga je
manje round tripova (npr. `effects` jednom po transakciji), ne finiji lock.

## Usput popravljeno: izgladnjivanje poola

Kod jednog ledgera prihvat je trajao 1,7 s od ukupnih 2,1 s, iako POST intenta ne uzima
lock. Svaki `process()` uzeo je konekciju iz poola (20) i na njoj čekao advisory lock, pa
inserti novih intenta nisu imali konekciju. Sada najviše `PG_LEDGER_GATE` (4) transakcija
istog ledgera po procesu drži konekciju, a ostale čekaju u memoriji. Red od jedne
transakcije bio je loš: `connect`, `begin` i lock postali su serijski, pa je obrada bila
oko 60 % sporija. S 4 transakcije prihvat traje ~0,4 s, a protok je isti (mjereno za
2, 4, 8 i 20; razlike su unutar šuma).

## Usput popravljeno: deadlock pri startu

Prvi `npm run check` ove sesije pao je na Postgresu (`40P01` u `recovery.test.ts` i 500 u
l6 „grouping”). Uzrok je indeks threadova iz `7bcb763`. Shema se izvršavala kao jedna
transakcija, a `create index if not exists` uzima share lock na tablicu i kad indeks
već postoji. Locki su se gomilali redom changes pa records, dok proces koji već radi piše
records pa changes. Sada se svaka naredba sheme izvršava zasebno.
