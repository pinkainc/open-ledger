# Nastanak: usmjeravanje i domene (S5, prvi dio, 2026-10-10)

Sesija S5 iz lanca (`docs/handoffs/`). Ostala je bez konteksta usred paketa, pa se
nastavlja opet kao S5 (pravilo 4 u `docs/handoffs/README.md`).

## Što je napravljeno

- **Autorizacija bridge proofova (točka 0, nasljeđe S4).** Scenarij `bproofs`, snimljen
  tri puta jer je svaka snimka pokazala da je pretpostavka kriva. Prva je pokazala da se
  pravilo iz docsa (`{sign, record: intent}` na bridgeu) uopće ne da zapisati, jer `sign`
  nije akcija. Druga je pokazala da ključ bridgea ne prolazi ni s `{any, record: intent}`
  na ledgeru. Treća je potvrdila `create` na `intent-proof` (trace reference:
  `assertAccessToCreateProof`). Snimka pokazuje i da referenca ne provjerava je li
  izvještaj na entryju poslao baš bridge: operatorov `prepared` commita intent.
  Implementirano (`app.ts`, `access.ts`, `errors.ts`), 45/45 + 20/20.
- **Validacija `access` polja na svakom recordu** prema specu (akcije i recordi kao enum,
  `oneOf` pravilo ili policy). Bez toga bismo prihvatili `sign`.
- **DTC policy** je cijeli izvršitelj 2PC koraka, opisan samo u specu. Premješten je u S10.
- **Anchor forwarding** je snimljen (`forwarding`, treća snimka), ali još nije
  implementiran. Nalazi su u `FINDINGS.md`, a razina čeka u `conformance/pending.json`.
  Prve dvije snimke su pale zbog grešaka scenarija: putanja `/v2/v2`, nevaljane policyje
  koje su ostale na snazi, spajanje polja u SDK-u.
- **`domains2`** je napisan, ali nije snimljen.

## Zašto tri snimke za jedan odgovor

Svaka snimka ostavlja trajni ledger. Ovdje su se ipak isplatile. Bez druge snimke
odgovor bi bio „pravilo na ledgeru”. Bez treće ne bismo znali da je zapis `intent-proof`
zaseban, ni da `record: intent` ne pokriva proof. Pouka za iduće scenarije: kad tražiš
koje pravilo nešto dopušta, stupnjuj pravila unutar iste snimke, od najužeg prema
najširem, i iza svakog koraka napravi pokušaj.

## Nastavak S5: anchor forwarding izgrađen

- **`server/src/forwarding.ts`**: traženje aspekta iz `processing` policyja (status
  nije bitan; dvije vrijednosti za istu akciju i nepostojeći bridge daju 500 tek pri
  upotrebi), JWT ledgera za bridge (`iss: ledger:<l>`, `sub: system@<l>`, `aud`, 24 h),
  poziv na `{server}/v2/anchors…` i provjera odgovora (hash, potpisi, 401 → 500, bez
  recorda → 502, potpisana greška bridgea → `ForwardedError`).
- **`app.ts`**: `create`, `update` i `addProof` dobili su kuku koja vidi zapis prije
  spremanja. Validate i synchronize zato prolaze kroz iste lokalne provjere kao i bez
  forwardinga, a proxy ide mimo lokalnih zapisa. Validacija `processing` policyja je u
  `schemas.ts`: deset grešaka `policy-data` anyOf, s prvom greškom processing grane u
  sredini.
- **`compare.ts`**: `Bearer <jwt>` se uspoređuje po dekodiranim claimovima, gola adresa
  bridgea se normalizira, a samo `PUT /intents/…` se sortira kao statusni poziv (ostali
  PUT-ovi zadržavaju mjesto).
- **Odstupanje**: synchronize `sign` je na referenci 500 bez poziva bridgeu. Mi
  postupamo kao kod validate (forwarding #63–64, bridge #29).
- Odluke koje snimka ne pokriva su u FINDINGS: zadane strategije prema docsu,
  synchronize na drop/query, kada fallback lista pita bridge. `filter` policyja još se
  ne primjenjuje (TODO).

## Nastavak S5: domene i `(?)` iz Routes

- **`domains2`** je snimljen iz prve (43/43 nakon gradnje). U `access.ts` je nova
  razina `domain` između pravila zapisa i ledgera: pravila domene i svih domena iznad
  nje. Novi zapis se procjenjuje prema domeni u koju ulazi, a zapisi domena ne
  nasljeđuju ništa. U domeni signer pravilo prihvaća i ključ tokena, pa daje i read. To
  je prva snimka liste iz koje je skriveno ono što pozivatelj ne smije čitati.
- **`routes2`** (47/47 + 5/5): dubina ruta je tri skoka, a uz to tekst za
  nerazriješen cilj rute. `secure` pravila bridgea vrijede i za pozive za anchore i
  domene. Lista koju vrati bridge ne provjerava se. Lookup na walletu bez bridgea vraća
  `[]`. Drop walleta s anchorima odbija se i kad je `walletRequired` isključen. Sve
  bez petlji: svaka ruta se razriješi unutar jednog intenta.
- Dvije snimke u ovom dijelu (`domains2`, `routes2`, nijedna ponovljena) i dva trajna
  ledgera u footprintu.
