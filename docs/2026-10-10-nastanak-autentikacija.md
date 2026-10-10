# Nastanak: autentikacija (S2, 2026-10-10)

Sesija S2 iz lanca `docs/handoffs/`. Sve je snimljeno na sandboxu 2.47.4 i
reproducirano na memory i Postgres storeu. Detalji su u `FINDINGS.md`.

## Što je napravljeno

| Paket | Snimke | Rezultat |
| --- | --- | --- |
| Signer factors (9 operacija) | `factors` 43 | 43/43 |
| `POST /oauth/token`, RS256 bearer tokeni | `oauth` 21 (snimljeno dvaput) | 21/21 |
| Provjera claima `hsh` | `hsh` 18 | 18/18 |
| OAuth2 cache tokena za bridgeove | — (`secure` i dalje jednak) | unit testovi |

Operacije: 122 → 132 od 146. Četiri nova ledgera na sandboxu, sva u `footprint.jsonl`.

## Odluke

- **`hsh` se provjerava prema javnoj adresi servera.** Referenca odbija hash izračunat
  nad adresom koju je klijent stvarno koristio (proxy za snimanje). Zato `run.sh`
  našem serveru u checku postavlja `PUBLIC_URL` na adresu reference, a scenarij računa
  `hsh` nad `HSH_URL`, istom adresom u oba moda. SDK-ov `createHsh` iza proxyja ne
  prolazi ni na referenci ni kod nas.
- **Factor je record u ledgeru**, ključ mu je handle na razini ledgera, a ne signera.
  Duplikat pod drugim signerom nije snimljen. `kid` OAuth tokena traži factor po
  handleu, pa je jedinstvenost na razini ledgera prirodna.
- **`include=meta.secret` otkriva tajne u čistom obliku**, i privatni ključ key-paira.
  Tako radi referenca. Mi uz to tražimo `read` na `signer-factor-secret`, jer taj tip
  recorda postoji u access enumu. Snimka to nije mogla razlikovati.
- **Redoslijed provjera u `/oauth/token`** je snimljen do vjerodajnica. Što dolazi
  prvo kad nema policyja i vjerodajnice su krive nije snimljeno: mi prvo gledamo
  policy. To je `(?)` u `TODO.md`.
- **OAuth2 cache** je unutarnja optimizacija. Comparator ionako spaja ponovljene iste
  zahtjeve za token, pa snimka `secure` ostaje jednaka bez novog unosa u
  `divergences.json`.

## Usput

- Validator tijela sada provjerava `hash` (64 hex znaka) kad postoji. Referenca prazan
  hash odbija kao grešku sheme, a mi smo prije javljali `crypto.hash-invalid`.
- Komparator normalizira JWT-ove (dekodira header i claimove), generirane OAuth
  vjerodajnice i duge base64 ključeve (RSA DER).
- `README` „Known gaps”: `hsh` i access policies više nisu rupe. Ostala je napomena
  da iza proxyja treba `PUBLIC_URL`.
- Check na početku sesije pao je jer je `run.sh` izmijenjen dok se izvodio. Bash čita
  skriptu u hodu, pa skripte ne treba dirati dok check radi.
