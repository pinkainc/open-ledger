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

## Točka 5: sve razine ponovno snimljene na 2.47.5

Sandbox je 2026-10-19 služio **2.47.5**, a snimke su nastale od 25.9. do 11.10. (2.45–2.47.4).
Ponovno je snimljeno svih 56 razina osim `daywindow`, jedna za drugom, i sve su prošle iz
prvog pokušaja (oko 70 minuta, 56 novih ledgera u `footprint.jsonl`). `daywindow` se snima
samo pred UTC ponoć, pa ostaje na staroj snimci. `cli` je snimljen s CLI-jem **2.47.0**
(`npm i -g @minka/cli@2.47.0`; lokalno je prije bio 2.45.1).

Jedina promjena reference: popis sistemskih shema (`filters`) sada ima `key-pair` na
prvom mjestu. Dvanaest shema nastaje u istom trenutku, pa redoslijed slijedi luidove i
nasumičan je, isto kao `custom.anchors`. `compare.ts` ih zato uspoređuje kao skup, i to
prije nego što luidovi postanu tokeni (tokeni se broje redom pojavljivanja).
`SEMVER` je 2.47.5.

Iznimke: `secure` i `signals2`. Usred njihovih snimki sandbox nije razriješio DNS
cloudflare quick tunela (`ENOTFOUND …trycloudflare.com`), pa su pozivi bridgeu pali. Te
snimke su vraćene na stare, a ledgeri ostaju u footprintu. Isto vrijedi za sistemske
policyje (`records2`: `access-policy:status` je sada prvi).

## Točka 6: svih 146 operacija potvrđeno

29 operacija bez snimke bile su generičke operacije nad zapisom na vrstama do kojih
nijedan scenarij nije došao: proof, access check, changes, change po broju, drop preko
`POST …/drop` i veza kruga i signera. Pokriva ih jedna nova razina, `surface`: jedan
ledger, nijedan izlazni poziv (bridge i webhook gađaju zatvoreni lokalni port). Snimka
je otkrila dvije razlike:

- **Zahtjev pisanja bez `content-type`** referenca odbija na svakoj ruti s 422
  `record.schema-invalid`, „Schema validation error: unsupported media type undefined”,
  `errors: [{path: '/v2/wallets/:id', message}]`. To je njezin OpenAPI validator. Mi smo
  na vezi kruga vraćali 500 (`verifyProofs(undefined)`), a na walletu poruku Ajv-a. Sada
  to radi jedan `preValidation` hook u `app.ts`.
- **Čitanje veze koje nema** je 422 `record.relation-not-found` „Link not found”, ne 404.
