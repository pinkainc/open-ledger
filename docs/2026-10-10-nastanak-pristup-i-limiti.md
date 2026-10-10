# Nastanak: pristup i limiti (S1, 2026-10-10)

Sesija S1 iz lanca `docs/handoffs/`. Sve je snimljeno na sandboxu 2.47.4 i
reproducirano na memory i Postgres storeu. Detalji su u `FINDINGS.md`.

## Što je napravljeno

| Paket | Snimke | Rezultat |
| --- | --- | --- |
| Access policies, `policy-based` | `policies` 65, `policies2` 36 | 65/65, 36/36 |
| Dnevni limiti | `limits2` 67, `limits3` 27, `limits4` 17, `limits5` 28 | sve jednako, 12 namjernih odstupanja |
| Dozvole stavki | `claims2` 15 | 15/15 |

## Odluke

- **Gate vrijedi i za čitanje.** Čitanje ga ipak prolazi kad pravilo ledgera ili servera
  izravno daje to čitanje. Ključ iz tokena zadovoljava `signer` pravilo za `access`.
  Bez toga se `access4` i `policies2` ne mogu uskladiti istodobno.
- **`policy-based` ne poštuje ni serverska pravila.** U `policies2` C ulazi, ali ne može
  čitati ledger. Docs kažu „server → active policies”, a snimka kaže drukčije.
- **Migracija strategije nije jednosmjerna.** Referenca prihvaća povratak na
  `record-based`, pa ga prihvaćamo i mi. Docs tvrde suprotno.
- **Dnevni limiti** odbijaju se prije pripreme, kao `maxBalance`. Referenca intent
  ostavlja `committed` zauvijek, a zadužena sredstva rezervirana. To je upisano u
  `divergences.json`.
- **Prozor od 24 sata** je klizni, jer granica dana nije snimljena. Brojanje čita sve
  dovršene intente ledgera. To je ispravno, ali sporo, i stoji u `TODO.md`.

## Usput

- Access check više ne traži `read` na recordu i skriva `bearer` (`policies` #56).
- Stari unit test „bearer rule … for reads” pretpostavljao je čitanje bez `access`. Snimka
  `policies2` #5 to opovrgava, pa je test ispravljen.
- L6 test „a bridge that never answers a prepare” jednom je pao pod punim suiteom zbog
  roka od 5 s. Sam prolazi 3/3, a prolazi i bez promjena iz S1. Zapisano u `TODO.md`.
