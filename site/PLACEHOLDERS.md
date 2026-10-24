# Placeholderi stranice

Sve što na stranici čeka korisnikovu odluku. U UI-ju je vidljivo kao `[[TODO: …]]`
(klasa `.todo`, žuta isprekidana oznaka). Kad se riješi: zamijeni u kodu, izbriši redak.

| Oznaka | Gdje | Što treba | Tko odlučuje |
| --- | --- | --- | --- |
| `[[TODO: kontakt]]` | `src/components/Footer.astro` (podnožje, oba jezika) | kontakt: e-mail, GitHub issues ili oboje | korisnik |
| `[[TODO: hrvatski opseg za …]]` | `src/i18n/copy/hr.ts` (`levels.scope`), samo ako `facts.json` dobije razinu čiji prvi fixture nije u `levelKeys` (`copy/types.ts`) | hrvatski opis opsega nove razine, i ključ u `levelKeys` | tko doda razinu |
