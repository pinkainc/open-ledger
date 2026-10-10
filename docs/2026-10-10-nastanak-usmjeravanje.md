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
