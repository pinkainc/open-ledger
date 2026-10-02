# Nastanak L7 i dalje — 2026-10-02, četvrta sesija

Nastavak [`2026-09-26-nastanak-e2e-l6-l8.md`](2026-09-26-nastanak-e2e-l6-l8.md).
Ponašanje reference je u [`FINDINGS.md`](../FINDINGS.md), plan u [`TODO.md`](../TODO.md).
Ovo je prva sesija vođena iz ovog repoa, a ne iz `../docs.minka.io`. Svaka razina
ima svoje poglavlje, a tablica „Gdje smo“ na kraju opisuje stanje nakon zadnje.

## L7 — threadovi, istek threada, ograničenje veličine

### Što je napravljeno

- **Thread se commita kao cjelina.** Intent koji je napravio `forward` čeka u
  `meta.status: prepared` (i s `routed`) dok svaki intent threada nije pripremljen.
  Root commita prvi, a svaki forward intent nakon intenta koji ga je napravio.
- **Thread i pada kao cjelina.** Kad jedan intent padne, ostali dobivaju isti
  `failed {reason, detail}`, zatim `aborted` i otpuštanje rezervacija (core `aborted`
  po unosu), abort bridgeova kojima je poslan prepare, i `rejected`. To vrijedi za
  odbijen forward, za bridge koji odbije prepare i za istek.
- **Popravak koji je otkrila snimka:** forward intent s bridgeanim dijelom slao je
  prepare iznova na svaki izvještaj. Marker „prepare je krenuo“ bili su core proofovi,
  a forward intent ih nema. Sad ga zamjenjuje oznaka (`Store.once`, novi `Store.marked`).
- **Debit forward intenta ne provjerava saldo.** Troši kredit svog threada koji je
  pripremljen, ali još nije commitan. Wallet je u tom trenutku prazan, a referenca ga
  propušta.
- Scenarij `l7` (33/36 i 12/15, ostatak su namjerne razlike), 5 unit testova u
  `server/test/l7.test.ts`.

### Metoda

Kao i prije, ali s jednim novim pravilom, naučenim na teži način: **prije snimanja
pitaj može li slučaj napraviti neograničen posao na referenci.** Prva snimka imala je
dva walleta koji si međusobno prosljeđuju. Referenca ograničenje od 10 intenata
provjerava tek kad je thread pripremljen, pa je u devet minuta napravila oko 5000
intenata na Minkinom stagingu. Petlju sam prekinuo izmjenom ruta tih dvaju walleta, što
je dopuštalo pravilo `{any, any}` testnog ledgera. Tek tada je referenca javila
`core.thread-size-exceeded`. Takvi slučajevi idu samo u unit testove (zapisano i u memory).

Ishod „tihog“ forwarda i petlje pročitan je izravno sa sandboxa (`curl`, bez proxyja).
U snimci je samo ograničena verzija.

```mermaid
sequenceDiagram
  participant R as root intent
  participant F as forward intent
  participant B as bank
  R->>R: resolved, core prepared, prepared
  R->>F: novi intent u istom threadu (data.origin)
  Note over R: čeka u prepared
  F->>B: POST /credits
  B-->>F: prepared
  F->>F: prepared
  F-->>R: thread pripremljen
  R->>R: committed, cleared, completed
  R-->>F: origin commitan
  F->>F: committed
  F->>B: commit
```

### Odluke

- **Ograničenje veličine provjerava se pri prosljeđivanju.** Intent čiji bi forward
  napravio 11. intent u threadu pada s reasonom i detailom reference. Ovo je namjerno
  odstupanje, jer referenca petlju prvo pusti.
- **Istek forward intenta.** Referenca ga ne istekne ni nakon devet minuta, pa thread
  ostaje zauvijek s rezerviranim novcem. Mi ga isteknemo, a thread pada s
  `core.intent-expired`. Odstupanje je u `divergences.json` (l7 #25–27, bridge #12–14),
  jer dokumentacija kaže da istek abortira cijeli thread.
- **Thread se traži skeniranjem intenata ledgera,** ali samo za threadove s forwardom
  (oznaka `thread … forwarded`). Ostali intenti ne plaćaju ništa. Indeks po
  `meta.thread` je u TODO-u.
- **`routed` dok čeka:** uvijek. Referenca ga ima ili nema ovisno o utrci (dvije
  snimke, dva ishoda).

### Zamke

1. **Neograničen scenarij na referenci** (vidi Metoda). Ponovna snimka koštala je još
   dva ledgera na sandboxu.
2. **Slučaj koji kod nas istekne za sekundu, a na referenci nikad,** pomaknuo je sve
   iza sebe (bridge log, numeraciju coreId-a). Zato je premješten na kraj scenarija.
3. **Comparator:** id intenta upisan u tekst (`… for intent 04VC…`) i u URL statusnog
   PUT-a sad se normalizira. Razmjena koja postoji samo na jednoj strani može biti
   namjerna razlika. Izvještaji istog bridgea s istim statusom slažu se po mjestu unosa
   u trailu, a `core-N` testnog bridgea više nije identitet. Bez toga je `l6` na
   Postgresu pukao na utrci koju je otkrila sporija obrada.
4. **`settle` u scenariju koji `aborted` smatra konačnim** pročitao bi intent prije
   nego što bridge potvrdi abort. Polling ide mimo proxyja, pa popravak ne mijenja
   fixture.

## Bridge `secure`, retry cap, traits, `activate`

### Što je napravljeno

- **Secreti.** Vrijednost pravila u `secure` je referenca `{{ secret.<ime> }}`, a sama
  vrijednost stiže jednom, u `meta.secret`. Ledger je zapečati (AES-256-GCM, master
  ključ `OPEN_LEDGER_MASTER_KEY`, kontekst `ledger/bridge/handle/ime` kao AAD) i nikad
  je ne vraća. Referenca bez vrijednosti i obična vrijednost odbijaju se istim greškama
  kao na referenci.
- **`header` i `oauth2`** na svakom pokušaju isporuke (`Bridges.authorize`). OAuth2 token
  traži se prije svakog poziva, kao kod reference.
- **Retry cap:** pet retryja, zatim `cancelled delivery.retry-cap-exhausted`. Zadnji
  neuspjeli pokušaj nosi `detail.body`, i to je pravilo koje objašnjava i 501 iz `events`.
- **Traits:** popis metoda i `{method, filter}`. Bez `statuses` nema PUT-a, a filtrirani
  unos ledger knjiži sam.
- **`POST /bridges/{id}/activate`** i status isporuke `running`.
- Scenarij `secure` (43/44 + 39/39; jedna razlika je vremenska), 7 unit testova.

### Odluke

- **Master ključ je jedan po serveru, ne po ledgeru.** Kontekst (AAD) veže svaki
  secret za ledger, bridge i ime, pa se zapečaćena vrijednost ne može podmetnuti drugom
  bridgeu. Bez varijable server radi s ključem po procesu i na Postgresu upozorava, jer
  bi secreti nakon restarta bili nečitljivi.
- **Bez cachea OAuth2 tokena,** jer ga ni referenca nema. Dokumentacija ga obećaje, pa
  je u TODO-u.
- **Token zahtjevi u comparatoru uspoređuju se po obliku, jednom.** Referenca je za osam
  poziva tražila sedam tokena bez vidljivog razloga, dok se `Authorization` svakog
  poziva i dalje provjerava.

### Zamke

1. Uvjet „isporuke su se smirile“ (dva jednaka očitanja u 2 s) pada između dva retryja.
   Sad traži 16 s bez promjene.
2. Adresa token endpointa ne završava na `/v2`, pa je normalizacija adrese bridgea
   morala dobiti oblik i za ostale putanje na istom hostu.

## Effecti — signali, webhooki, effect prema bridgeu

### Što je napravljeno

- **Effect** (`$eff`) je zapis kao i ostali: kreiranje, čitanje, lista, izmjena,
  proofovi, changes, access check, drop (`DELETE` i `POST …/drop`).
- **Event** je zapis ledgera `{handle: evt_…, signal, …}` potpisan `system` ključem.
  Nastaje jednom po događaju i ide svakom effectu na tom signalu čiji `filter` odgovara.
  Svaki effect dobiva svoju isporuku `$evd`, upisanu u istoj transakciji kao i promjena
  koja ju je izazvala, kroz isti outbox kao pozivi bridgeovima (`data.effect`, `record`,
  `linked`).
- **Signali:** `<zapis>-created|updated|proofs-added` za svaku vrstu zapisa,
  `effect-dropped`, `intent-created`, `intent-updated` (po verziji intenta, s `parent`)
  i `balance-received` (po kreditu, s intentom u trenutku commita).
- **Isporuke:** `GET /effects/{id}/events[/{handle}]`, `…/events/retry` i `…/activate`
  dijele kod s bridgeovima. Webhook ide na `endpoint`, a effect prema bridgeu na
  `POST {server}/effects/{effect}`.
- Scenarij `effects` (51/51 i 21/21 na memory i Postgresu) i 5 unit testova
  (`server/test/effects.test.ts`).

### Metoda

Kao i prije. Testni bridge je naučio primati webhooke (`/hooks/*`) i pozive
`/v2/effects/*`. Comparator normalizira `evt_` handleove i 17-znakovne idove u
navodnicima. Effect pozive slaže po odredištu, signalu i verziji zapisa, a liste
isporuka effecta po onome na što se event odnosi.

Prije snimanja provjereno je da je scenarij ograničen: nijedan effect ne stvara
intent, svaki endpoint koji pada se oporavi ili vrati 501, a `intent-updated` je
filtriran na jedan intent. Dvije snimke (dva trajna ledgera). Prva je otkrila da
referenca trait `events` iz dokumentacije odbija, pa je druga snimljena s `effects`.

### Odluke

- **Trait je `effects`.** Dokumentacija (`register-effect.md`) kaže `events`, a referenca
  ga odbija. Pratimo referencu, a zapisano je u FINDINGS.
- **Utrka reference se reproducira.** `completed` verzija intenta nosi kao `parent`
  commit, a ne verziju nakon clearancea. Isto je u obje snimke, pa to tretiramo kao
  pravilo („verzija clearancea nikad nije parent“), ne kao šum.
- **Nepostojeći bridge** daje isporuku bez zapisa, linka i outputa, deset pokušaja
  `delivery.unexpected-error`, pa `cancelled`. Vjerno preslikano (`unreachable` na
  pozivu, vlastiti cap).
- **`data.signal` filter na listi effecata** je 400, kao na referenci. Ostali filteri
  rade kao drugdje, jer ih nismo snimili.
- Signali koje nismo snimili (proofs-added, bridge-entry, wallet-limited,
  `intent-updated` bridgeanog ili odbijenog intenta) rade po tipovima SDK-a i stoje u
  TODO-u s `(?)`.

### Zamke

1. **Docs i referenca se razilaze** (trait). Prva snimka je zato potrošena na
   effect prema bridgeu koji nije postojao. Iz nje je ipak ispao nalaz o nepostojećem
   bridgeu, koji je u drugoj snimci namjerno zadržan.
2. **Effect isporuka nema `detail.body`** na zadnjem neuspjelom pokušaju, za razliku
   od poziva bridgeu. To je jedina razlika koju je prvi check pokazao.

## Brojke

| | početak | kraj |
| --- | --- | --- |
| Operacije | 82/146, 60 snimkom | **83/146, 61 snimkom** |
| Razine u `npm run check` | 13 | **15** (+ l7, secure) + `minka` CLI e2e |
| Testovi (memorija + Postgres) | 217 | **239** |
| Novi ledgeri na sandboxu | — | 4 (l7 ×3, secure); prvi l7 s petljom od ~5000 intenata |

## Gdje smo (2026-10-02, večer)

| Mjera | Stanje |
| --- | --- |
| Operacije API-ja | 97/146 (66 %), od toga 71 potvrđeno snimkom (49 %) |
| Ljestvica L0–L9 | L0–L7 gotovo; rute gotove; L8 gotov (bridgeovi sa `secure`, retry capom i traitsima, effecti); L9 ništa |
| Resursi s 0 operacija | anchors, domains, reports, oauth, system |
| Testovi | 249 unit, 16 conformance razina na memory i Postgresu, `minka` CLI e2e |

Effecti su gotovi: ledger sad javlja vanjskim sustavima što se dogodilo (webhook ili
bridge s traitom `effects`), s isporukama, retryem i `activate`. Za produkciju i dalje
nedostaju: anchors i domains, reporti, access policy, korisničke sheme, provjera
`hsh`, šifrirani ključevi ledgera i zaključavanje po walletu.

## Sljedeće

Redom iz plana: korisničke sheme koje validiraju zapise (prvo snimiti greške
reference), zatim anchors i domains (uključujući `GET /wallets/{address}/anchors`),
pa reports i access policy, L9 cross-ledger i produkcijska jezgra. Usput: `SEMVER`
servera je još 2.45.5, a referenca je na 2.46.5 (DTC policy iz 2.46 open-ledger nema).
