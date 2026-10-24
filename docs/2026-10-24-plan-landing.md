# Plan: landing stranica `open-ledger.mpt.hr`

Stanje (2026-10-24, W8): **W1–W8 gotovi, ništa nije objavljeno.** Stranica se gradi lokalno
(`npm --prefix site run build`), `npx wrangler deploy --dry-run` u `site/` prolazi (wrangler 4.151.3,
`site/wrangler.jsonc`). Sljedeće je D1 (deploy) i to tek na izričit „deployaj” korisnika:
`docs/handoffs/landing/D1.md`. Što čeka korisnika: `site/PLACEHOLDERS.md`. Polazni commit plana `c033b0b`.

## Odluke (zapisane, ne otvaraju se po koracima)

| Pitanje | Odluka | Zašto |
| --- | --- | --- |
| Gdje razvijamo | **samo lokalno** dok korisnik ne kaže drukčije | odluka korisnika 2026-10-24 |
| Kako provjeravamo | **claude-in-chrome**, Brave `ms@ff.hr` (globalni CLAUDE.md), `http://localhost:4321` | memory `build-local-verify-in-browser` |
| Jezici | **hrvatski i engleski**: `/hr/…` i `/en/…`, `/` šalje na jezik preglednika, prekidač jezika na svakoj stranici, `hreflang` | odluka korisnika 2026-10-24 |
| Stack | **Astro** (statički izlaz, bez JS-a na klijentu osim prekidača teme/jezika) u `site/` s vlastitim `package.json` | server ostaje bez novih ovisnosti; komponente i i18n bez vlastitog generatora |
| Brojke | **nikad ručno u tekstu**: `scripts/site-facts.ts` ih vadi iz repoa u `site/src/data/facts.json`; `npm run check` pada ako je zastario | README je već jednom imao 217 testova dok ih je bilo 446 |
| Hosting (kasnije) | Cloudflare Workers static assets, custom domain `open-ledger.mpt.hr` (zona `mpt.hr` je već na Cloudflareu) | besplatno, isti račun |
| Ime Minka | samo nominativno („compatible with the Minka Ledger API”), bez njihovog logotipa i boja, disclaimer u podnožju kao u README-u | README, odjeljak License |
| Registar teksta | inženjerski (skill `register`): zaključak prvi, bez marketinške drame | |

## Što stranica mora imati

Jedna duga početna stranica po jeziku + nekoliko podstranica. Svaka tvrdnja ima izvor u repou.

1. **Hero** — što je (Minka-kompatibilan ledger, MIT), jedna rečenica o S3 analogiji,
   gumbi: GitHub, „Pokreni lokalno”, „Kako mjerimo kompatibilnost”.
2. **Brojke** — 146/146 operacija, sve potvrđene snimkom; broj snimljenih razmjena; broj
   testova; verzija sandboxa protiv koje je zadnje snimano. Iz `facts.json`.
3. **Kako se kompatibilnost dokazuje** — dijagram SDK → proxy → sandbox / open-ledger →
   compare; placeholderi; `divergences.json` kao javni registar namjernih odstupanja.
4. **Razine L0–L9** — tablica iz README-a, ali generirana iz `facts.json`.
5. **Interoperabilnost s Minkom** — `ledger-bridge` u oba smjera, 325 = 325.
6. **Pokrivenost API-ja** — podstranica `/coverage`: resursi i operacije (iz `COVERAGE.md`).
7. **Pokretanje** — `npm install`, `npm run check`, `npm start`, Postgres, varijable
   okoline, službeni `minka` CLI i SDK protiv lokalnog servera.
8. **Dizajn i ograničenja** — Postgres i memory store, serijalizacija po ledgeru i
   izmjerene brojke (`scripts/bench.ts`), invarijante iz testova, poznate rupe (`hsh` i
   `PUBLIC_URL`).
9. **Što ovo nije** — Non-goals iz README-a (licenca, AML/KYC…).
10. **Nalazi o referenci** — podstranica `/findings`: sažetak `FINDINGS.md` i divergencija.
11. **Podnožje** — licenca MIT, GitHub `pinkainc/open-ledger`, disclaimer o Minki, kontakt.
12. **Tehničko** — `<title>`/description po jeziku, Open Graph slika (HR i EN), favicon,
    `sitemap.xml`, `robots.txt`, `hreflang`, `llms.txt`, svijetla i tamna tema,
    radi na 360 px, WCAG AA kontrast, bez vanjskih fontova ili trackera.

## Kako se izvršava: linearno, jedan subagent po koraku

Glavna sesija je **orkestrator** i radi autonomno (odluka korisnika 2026-10-24): pokrene
subagent za korak N iz `docs/handoffs/landing/WN.md`; subagent na kraju napiše
`W(N+1).md`, pozove `wrap-up` i vrati sažetak; orkestrator pregleda commit i build, pa
pokrene sljedećeg. Nikad dva subagenta istovremeno. Pravila lanca:
`docs/handoffs/landing/README.md`.

- **Browser** radi subagent koji gradi (Brave `ms@ff.hr`, claude-in-chrome), jedan po
  jedan pa nema sukoba oko tab grupe.
- **Brief subagenta** = njegov `WN.md` + ovaj plan. Subagent ne čita cijele
  fajlove (grep + `sed -n`), ne commita, ne deploya, zapisuje rezultat na disk i završava
  kratkim sažetkom: što je napravio, što nije, otvorena pitanja.
- **Model i effort**: piše se uz korak; `effort` uvijek eksplicitno. Bez Fablea.
- **Procjena ukupno**: 8 subagenata, ~15–35 poziva svaki, ~200 poziva sve skupa, na
  Sonnetu/Opusu. Ako orkestrator pređe ~250k konteksta: `/wrap-up`, nastavak iz ove
  datoteke (prvi neoznačeni korak).

## Koraci

### W1 — Inventar sadržaja i izvora · Sonnet 5.5, effort medium
Pročitaj `README.md`, `COVERAGE.md`, `FINDINGS.md`, `conformance/divergences.json`,
`docs/2026-10-10-plan-do-paritete.md` (samo „Gdje smo”), `scripts/bench.ts` izlaz u
`docs/2026-10-19-nastanak-benchmark.md`. Izlaz: `site/CONTENT.md` — za svaki odjeljak
s popisa gore: tvrdnje, svaka s izvorom (`fajl:linija`), i popis brojki koje treba
generirati. Bez prijevoda još.
**Gotovo kad:** svaki od 12 odjeljaka ima tvrdnje s izvorima; nema tvrdnje bez izvora.

### W2 — Generator brojki · Opus 5.5, effort medium
`scripts/site-facts.ts`: iz `COVERAGE.md`/`conformance/coverage.ts`, fixtures
(`conformance/fixtures/*.jsonl`), broja testova (`node --test` izlaz ili brojanje
`test(`), verzije iz servera, rezultata razina → `site/src/data/facts.json`. Način
`--check` koji pada ako je JSON zastario; dodati u `scripts/check.sh`. Unit test za
parser.
**Gotovo kad:** `npm run check` zelen, `facts.json` se poklapa s README tablicom (ili je
README kriv i to se zapiše).

### W3 — Kostur Astra i i18n · Opus 5.5, effort medium
`site/` s Astrom (zadnja stabilna verzija, točno pinana), `@astrojs/sitemap`, i18n
routing `hr` i `en`, layout s headerom (logo-tekst, navigacija, prekidač jezika i teme),
podnožje, tokeni boja na `:root` za svijetlu i tamnu temu, lokalni font stack. Prazne
sekcije s naslovima. `npm --prefix site run build` daje `site/dist/`.
**Orkestrator provjerava:** `/hr/` i `/en/` se otvaraju, prekidači rade, nema
horizontalnog scrolla na 360 px.

### W4 — Tekst EN i HR · Opus 5.5, effort medium
Iz `site/CONTENT.md` napiši copy za sve odjeljke na engleskom, zatim hrvatski kao
ravnopravan tekst (ne doslovni prijevod; terminologija: ledger, intent, claim, bridge
ostaju u kodu, u tekstu se objasne). Spremi kao `site/src/content/{en,hr}/*.md` ili
i18n rječnik. Brojke samo kao reference na `facts.json`.
**Gotovo kad:** oba jezika pokrivaju svih 12 odjeljaka; orkestrator pročita oba.

### W5 — Sekcije početne stranice i dijagrami · Opus 5.5, effort medium
Komponente za hero, brojke, „kako dokazujemo” (inline SVG dijagram, čitljiv u obje
teme), tablicu razina, interoperabilnost, pokretanje (blokovi koda s gumbom za kopiranje),
dizajn i ograničenja, non-goals.
**Orkestrator provjerava:** svaka sekcija u Braveu, 3 širine × 2 jezika × 2 teme,
screenshot u scratchpad.

### W6 — Podstranice `/coverage` i `/findings` · Sonnet 5.5, effort medium
Generirane iz `COVERAGE.md` / `FINDINGS.md` / `divergences.json` pri buildu (ne
kopirane), s filtrom po resursu. Naslovi i uvodi na oba jezika; sam sadržaj nalaza
može ostati engleski uz napomenu.
**Gotovo kad:** 146 operacija na stranici, broj se poklapa s `facts.json`.

### W7 — SEO, meta, pristupačnost · Sonnet 5.5, effort medium
Meta po jeziku, `hreflang`, canonical na `https://open-ledger.mpt.hr`, OG slike (statične
SVG→PNG pri buildu), favicon, `robots.txt`, `sitemap.xml`, `llms.txt`, `404` na oba
jezika, preusmjeravanje `/` prema `Accept-Language`/`navigator.language` s fallbackom
na `/en/`.
**Orkestrator provjerava:** Lighthouse (chrome-devtools MCP) ≥ 95 u sve četiri
kategorije na `/hr/` i `/en/`, provjera linkova (nijedan 404).

### W8 — Završni pregled i priprema za deploy (bez deploya) · Opus 5.5, effort medium
`site/wrangler.jsonc` (static assets iz `dist/`, route `open-ledger.mpt.hr` kao custom
domain), `site/README.md` s naredbama, README repoa dobiva poveznicu „Website” (još ne
živ). Pregled svih tvrdnji na stranici protiv `site/CONTENT.md` izvora.
**Gotovo kad:** `wrangler deploy --dry-run` prolazi lokalno; ništa nije objavljeno.

### D1 — Deploy (tek kad korisnik kaže)
Prijava u Cloudflare (`wrangler login` korisnik sam, `! npx wrangler login`), prvi
`wrangler deploy`, provjera `https://open-ledger.mpt.hr` u Braveu, zatim po želji
GitHub Action za deploy na push u `site/**` (secret `CLOUDFLARE_API_TOKEN` postavlja
korisnik). Ovo je vanjska akcija: ne radi se bez izričitog „deployaj”.

## Otvoreno za korisnika (ne blokira W1–W8)

- Kontakt u podnožju: e-mail, GitHub issues ili oboje?
- Treba li kasnije javna demo instanca servera (Node + Postgres, nije Workers) da se
  „probaj odmah” može kliknuti? Sad: samo upute za lokalno pokretanje.
