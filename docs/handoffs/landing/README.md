# Handoffi za landing stranicu (W1–W8)

Plan i odluke: `docs/2026-10-24-plan-landing.md`. Ovdje su samo pravila lanca i stanje.

## Lanac

Glavna sesija (orkestrator) pokreće **jednog subagenta po koraku, jednog za drugim**.
Subagent za korak WN:

1. počinje iz `docs/handoffs/landing/WN.md` (i ovog README-a i plana);
2. radi samo svoj korak;
3. na kraju:
   - označi WN gotovim u tablici „Stanje lanca” ispod i u `TODO.md` (odjeljak Website);
   - napiše `docs/handoffs/landing/W(N+1).md`: polazni commit, što je gotovo, što je
     ostalo (nedovršeno ide na **vrh**), odluke koje mijenjaju sljedeći korak, zatim
     zadatak koraka W(N+1) prepisan iz plana i dopunjen onim što je naučio;
   - pozove skill `wrap-up` (Skill tool). Handoff prompt je sadržaj `W(N+1).md`;
   - vrati orkestratoru kratki sažetak (≤ 15 redaka): commit, što je napravio, što nije,
     otvorena pitanja za korisnika.
4. Orkestrator pregleda commit, pusti `npm --prefix site run build` kad `site/` postoji,
   po potrebi dopiše primjedbe na vrh `W(N+1).md` i tek onda pokrene sljedećeg.

Gotovi `WN.md` se ne prepisuju.

## Zajednička pravila

- **Samo lokalno.** Nema `wrangler deploy`, nema objave, nema DNS-a. To je korak D1 i
  radi se tek na izričit „deployaj” korisnika.
- **Hrvatski i engleski**, ravnopravno. Brojke samo iz `site/src/data/facts.json` (od W2).
- **Browser:** claude-in-chrome, uvijek Brave `ms@ff.hr`, deviceId
  `80df9c18-1811-478c-80bc-8ead45619cfc` (`list_connected_browsers` → `select_browser`).
  Jedan tab u grupi koju javi `tabs_context_mcp`, zatvori ga na kraju. Nikad `open`
  za URL koji treba gledati. Bez dijaloga (`alert`/`confirm`). Dev server pokreni s
  `run_in_background`, ugasi ga na kraju.
- **Štedi kontekst:** grep + `sed -n` umjesto cijelih fajlova, ne čitaj isti fajl dvaput,
  zapisuj rezultat na disk usput. Bez Monitora koji javlja napredak. Bez daljnjih
  subagenata. Ako kontekst pređe ~200k: commitaj, napiši nastavak na vrh `WN.md`
  (broj se ne povećava) i završi s wrap-upom.
- `npm run check` mora ostati zelen prije commita koji dira `scripts/` ili server.
  Ne snimaj protiv sandboxa (ovaj lanac ne treba nove snimke).
- Commit poruke hrvatski, `tip(opseg): …`, s
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stageaj poimence. Push na `main`.
- Ne pitaj korisnika; odluči i zapiši odluku u handoff. Pitanja koja su doista njegova
  stavi u sažetak.

## Stanje lanca

| Korak | Paket | Stanje | Commit | Napomena |
| --- | --- | --- | --- | --- |
| W1 | Inventar sadržaja | gotovo 2026-10-24 | HASH | `site/CONTENT.md`; README repoa ima 2 zastarjele brojke (217 testova, „one” divergencija), vidi W2.md |
| W2 | Generator brojki | — | | |
| W3 | Kostur Astra, i18n | — | | |
| W4 | Tekst EN + HR | — | | |
| W5 | Sekcije i dijagrami | — | | |
| W6 | `/coverage`, `/findings` | — | | |
| W7 | SEO, a11y, Lighthouse | — | | |
| W8 | Završni pregled, dry run | — | | |
