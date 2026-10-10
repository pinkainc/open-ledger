# Handoffi za sesije S1–S11

Plan je u `docs/2026-10-10-plan-do-paritete.md`. Svaka sesija ima svoj handoff `SN.md`.
Korisnik nakon `/clear` kaže „nastavi zadnji handoff” ili zalijepi prompt iz clipboarda.

## Lanac

1. Sesija N počinje iz `docs/handoffs/SN.md`.
2. Sesija N radi svoj paket po pravilima ispod.
3. Na kraju sesija N:
   - označi `SN` kao gotov u tablici „Stanje lanca” ispod (commit, operacije, kratka napomena);
   - **ako je naučila nešto što mijenja neki od sljedećih paketa, uredi `S(N+1).md`**, a po
     potrebi i kasnije handoffe i plan. Primjeri: ponašanje reference drukčije od docsa,
     posao koji je ostao nedovršen, nova verzija Minke, paket koji je ispao veći ili manji.
     Nedovršeni dio paketa N ide na **vrh** `S(N+1).md`;
   - u `S(N+1).md` upiše polazni commit i brojke;
   - pozove `/wrap-up`. Handoff prompt za clipboard i `~/.claude/handoffs/open-ledger/` je
     sadržaj `docs/handoffs/S(N+1).md`.
4. Ako sesija ostane bez konteksta usred paketa, nastavak je opet `SN` s popisom onoga što
   je ostalo na vrhu datoteke. Broj se ne povećava.
5. Ako je posljednji paket gotov, a rezervne sesije nisu potrebne, lanac je zatvoren. Tada
   se samo osvježi „Gdje smo” u planu i `README.md`.

Handoff se smije mijenjati samo prema naprijed: gotovi `SN` se ne prepisuju, služe kao
povijest.

## Zajednička pravila (vrijede u svakoj sesiji)

- **Polazak:** `git pull && npm run check`, potvrdi u jednoj rečenici da je zeleno. Ako
  nije zeleno, prvo to popravi.
- **Ponašanje se snima, ne pogađa.** Napiši scenarij u `conformance/scenarios/`, pusti ga
  probno protiv našeg servera (`conformance/run.sh check <razina>`), zatim snimi protiv
  sandboxa (`conformance/run.sh record <razina>`). Implementiraj i piši unit testove
  paralelno. `compare.ts` mora reći da se sve podudara. Namjerna odstupanja idu u
  `conformance/divergences.json` s razlogom. Dokumentacija je hipoteza, ne referenca.
- **Nijedan slučaj ne smije napraviti neograničen posao na sandboxu** (memory
  `never-loop-on-sandbox`): bez ruta koje se međusobno prosljeđuju i bez petlji. Takvi
  slučajevi idu samo u unit testove.
- Snimaj samo kad se scenarij promijeni: svaka snimka ostavlja trajni ledger na stagingu.
- **Trag na sandboxu je trajna povijest** (od 2026-10-10). `run.sh record` svako snimanje
  upisuje u `conformance/footprint.jsonl`, i ono koje se odbaci ili padne, a
  `docs/sandbox-footprint.md` generira iznova. Ledgere stvara jedan ključ operatora iz
  `~/.config/open-ledger/sandbox-operator.json`; taj se ključ ne briše i ne commita.
  **Oba footprint fajla commitaj nakon svakog snimanja**, i kad se fixture vrati na staro.
  Log se ručno ne uređuje, samo se dopisuje. `npm run check` pada ako ledger iz fixturesa
  nije u logu ili je dokument zastario (`npx tsx conformance/footprint.ts render`).
- Snimku i check nikad ne pokreći istovremeno (portovi 4610, 4620 i 4630).
- CLI samo pod ptyjem (`tools/minka-seq.exp`) s izoliranim `HOME`. `~/.minka` korisnika
  se ne dira.
- **Autonomno:** ne pitaj korisnika, odluči sam i zapiši odluku. Svaki zeleni korak
  commitaj i pushaj na `main`. Uz to održavaj `TODO.md`, `FINDINGS.md`
  (`npx tsx conformance/coverage.ts`), `COVERAGE.md` i dokument sesije (nastavak
  `docs/2026-10-02-nastanak-l7-i-dalje.md` ili novi `docs/<datum>-nastanak-<tema>.md`).
- Nepovratne vanjske akcije, npr. objavu ili brisanje izvan repoa, ostavi korisniku.
- **Token budget:** bez Monitora koji javlja napredak. Duge jobove pokreni s
  `run_in_background` i javi se tek na kraju. Bez fan-outa subagenata za rutinski posao.
  Oko 150k konteksta zatvori sesiju po koraku 3 iz lanca.
- Ako docs mirror (`../docs.minka.io`) ili sandbox imaju noviju verziju od zadnje snimke,
  zapiši to u handoff sljedeće sesije. Ne snimaj sve iznova usred paketa.

## Stanje lanca

| Sesija | Paket | Stanje | Commit | Napomena |
| --- | --- | --- | --- | --- |
| S1 | Pristup i limiti | gotovo | `75f319a` | 122/146, 92 potvrđeno; policies, policy-based, dnevni limiti, `claims2`; S2 nije započet |
| S2 | Autentikacija (factors, oauth, hsh) | gotovo | `da44b4c` | 132/146, 101 potvrđeno; factors 43/43, oauth 21/21, hsh 18/18; OAuth2 cache za bridgeove |
| S3 | Reports | gotovo | `340c2fb` | 141/146, 110 potvrđeno; reports 49/54 + 13/14, reports2 236/243 (ostalo namjerno: 500 reference); `minka report` u CLI e2e |
| S4 | Ledger i sustav → 146/146 | gotovo | `0232437` | **146/146**, 115 potvrđeno; `ledgers` 43/43, `uschema2` 28/28, `secure2` 23/23; drop ledgera i journal isključeni kao na referenci (zastavice); mtls namjerno radi; točka 6 (bridge proofovi) prebačena u S5 |
| S5 | Usmjeravanje i domene | u tijeku | `338f2ce` | prvi dio: bridge proofovi (`bproofs` 45/45 + 20/20, `intent-proof`), validacija `access`, `forwarding` snimljen ali ne i izgrađen, DTC u S10; nastavak je opet S5 |
| S6 | L9 cross-ledger | otvoreno | | |
| S7 | Snimke `(?)`, 2PC i signali | otvoreno | | |
| S8 | Snimke `(?)`, domene, CLI | otvoreno | | |
| S9 | Testna pokrivenost i jezgra | otvoreno | | |
| S10 | Rezerva | otvoreno | | samo ako zatreba |
| S11 | Rezerva | otvoreno | | samo ako zatreba |
