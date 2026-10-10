# Ledger i sustav (S4, 2026-10-10)

Rezultat: **146/146 operacija**, 115 potvrđeno snimkom, 363 unit testa. Četiri nova
scenarija (`ledgers` 43, `uschema2` 28, `secure2` 23) podudaraju se s referencom na
memoryju i Postgresu. Točka 6 (autorizacija bridge proofova) nije započeta i ide u S5.

## Što je snimljeno i što smo napravili

| Tema | Referenca (2.47.4) | Mi |
| --- | --- | --- |
| `GET /ledgers` | ledgeri čiji je pozivatelj vlasnik, najnoviji prvi; stranac `[]`, bez tokena 403 `Cannot query ledger.`, s `x-ledger` 422 `api.no-tenant-allowed` | isto |
| `DELETE /ledger` | ledger razriješen, tijelo validirano (`luid` obavezan), zatim 404 `Route not found` | isto po defaultu; `OPEN_LEDGER_LEDGER_DROP=1` stvarno briše ledger |
| `POST /ledger` | nije rutiran: Expressov HTML 404 | isto po defaultu; sa zastavicom radi kao `DELETE` |
| `/system/requests[/{id}]` | 404 `Journaling is not enabled` | isto po defaultu; `OPEN_LEDGER_JOURNAL=1` vodi journal (`server/src/journal.ts`) |
| liste | akcija je `query` i odlučuje je ulaz u ledger; poredak po `meta.moment` silazno | isto; lista još zadržava samo zapise koje pozivatelj smije čitati (hipoteza, nije snimljeno) |
| duplikat ledgera | 409 potpisan novim, odbačenim ključem | isto |
| shema `extend` | sprema se, nikad se ne primjenjuje; prihvaća svakog roditelja | isto |
| generička `secure` pravila | validirana; bridge s njima se nikad ne zove (`delivery.unexpected-error`, intent ostaje `pending`) | isto za nepoznate sheme i mtls preko http; mtls preko https radi (namjerno odstupanje) |

## Odluke

- **Drop ledgera i journal su isključeni po defaultu**, jer su isključeni i na
  referenci. Uključena ponašanja nisu snimljena, nego su naša i pokrivena unit
  testovima (`server/test/ledgers.test.ts`).
- **mtls se primjenjuje.** Referenca ne zove bridge s mtls pravilom ni s ispravnim
  certifikatom i ključem. To je kvar reference, a docs opisuju mtls kao način zaštite
  bridgea. Kroz tunel se klijentski certifikat ne vidi, pa je mtls dokazan lokalnim
  HTTPS bridgeom (`server/test/mtls.test.ts`). `OPEN_LEDGER_BRIDGE_CA` dodaje privatni CA.
- **Testni certifikat i ključ u `secure2.ts` su javni namjerno.** Snimka čuva tijela
  zahtjeva, repo je javan, a par ne vrijedi nigdje.
- **Redoslijed izjednačenja se ne uspoređuje.** Sistemske sheme imaju isti moment, a
  dvije snimke su ih dale različitim redom. Scenarij zato lista filtrirano.

## Usput naučeno

- `npm run check` sada traje dulje od 10 minuta (`secure2` čeka odustajanje od
  isporuke, oko minutu po storeu). Pokreći ga s `run_in_background`.
- U check modu minuta isteka traje sekundu, pa intent od 60 "minuta" istekne nakon
  60 s. Scenarij koji čeka dulje mora skratiti čekanje, inače dobiva lažne abortove.
- `onSend` hook koji čeka (`await`) uz handlere koji sami zovu `reply.send()` šalje
  odgovor dvaput (`ERR_HTTP_HEADERS_SENT`). Journal zato piše iza odgovora, a čitanje
  journala čeka upise koji su u tijeku.
