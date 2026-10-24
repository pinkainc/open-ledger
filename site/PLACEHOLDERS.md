# Placeholderi stranice

Sve što na stranici čeka korisnikovu odluku. U UI-ju je vidljivo kao `[[TODO: …]]`
(klasa `.todo`, žuta isprekidana oznaka). Kad se riješi: zamijeni u kodu, izbriši redak.

| Oznaka | Gdje | Što treba | Tko odlučuje |
| --- | --- | --- | --- |
| `[[TODO: kontakt]]` | `src/components/Footer.astro` (podnožje, oba jezika) | kontakt: e-mail, GitHub issues ili oboje | korisnik |
| `[[TODO: hrvatski opseg za …]]` | `src/i18n/copy/hr.ts` (`levels.scope`), samo ako `facts.json` dobije razinu čiji prvi fixture nije u `levelKeys` (`copy/types.ts`) | hrvatski opis opsega nove razine, i ključ u `levelKeys` | tko doda razinu |

## Čeka korisnika, a nije `[[TODO]]` u UI-ju (stanje W8, 2026-10-24)

| Što | Gdje | Što treba | Tko odlučuje |
| --- | --- | --- | --- |
| GitHub Action za deploy | (nije napravljen) | želi li deploy na push u `site/**`; ako da, secret `CLOUDFLARE_API_TOKEN` (i `CLOUDFLARE_ACCOUNT_ID`) postavlja korisnik | korisnik |
| Javna demo instanca servera | plan, „Otvoreno za korisnika” | treba li „probaj odmah” (Node + Postgres, nije Workers); sad samo upute za lokalno pokretanje | korisnik |
