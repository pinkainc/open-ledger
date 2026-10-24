# Website `open-ledger.mpt.hr`

Static landing page for open-ledger, English and Croatian, built with Astro into `dist/`
and served by Cloudflare Workers static assets (`wrangler.jsonc`). **Not deployed yet**:
the first deploy is step D1 of `docs/2026-10-24-plan-landing.md`, run by the owner.

Every number on the page comes from `src/data/facts.json`, which `scripts/site-facts.ts`
in the repository root generates. `/coverage/` and `/findings/` are rendered at build time
from `COVERAGE.md`, `FINDINGS.md` and `conformance/divergences.json`. Text that waits for a
decision is marked `[[TODO: …]]` and listed in `PLACEHOLDERS.md`.

## Commands

Run in `site/` unless noted.

| Command | What it does |
| --- | --- |
| `npm install` | dependencies (Astro, marked, TypeScript, wrangler; versions pinned) |
| `npm run dev` | dev server on http://localhost:4321 (`npx astro dev stop` ends it; it daemonizes) |
| `npm run build` | typecheck, OG staleness check, `astro build` into `dist/` |
| `npm run preview` | serves `dist/` on http://localhost:4321 |
| `npm run og` | renders `public/og-{en,hr}.png` from `facts.json` (needs `rsvg-convert`, `brew install librsvg`) and writes `scripts/og.sha256` |
| `npm run og:check` | fails when the committed OG images no longer match `facts.json` (no `rsvg-convert` needed) |
| `npm run deploy:dry-run` | build, then `wrangler deploy --dry-run`: validates `wrangler.jsonc` and lists the assets, uploads nothing, needs no login |
| `npx tsx scripts/site-facts.ts` (repo root) | rewrites `facts.json`; run `npm run check` first, it reads the test count from `.rec/test.log` |

`npm run check` in the repository root runs `site-facts.ts --check` and `make-og.mjs --check`,
so stale numbers or a stale OG image fail it.

When numbers change: `npm run check` (root, fails on stale facts), `npx tsx scripts/site-facts.ts`,
`npm --prefix site run og`, commit `site/src/data/facts.json`, `site/public/og-*.png` and
`site/scripts/og.sha256`.

## Deploy (step D1, owner only)

```sh
npx wrangler login         # once, in the browser, Cloudflare account that holds mpt.hr
npm run build
npx wrangler deploy        # creates the Worker and the custom domain open-ledger.mpt.hr
```

`wrangler.jsonc` sets `workers_dev: false` and `preview_urls: false`, so the custom domain
is the only address. The custom domain creates its own DNS record in the `mpt.hr` zone;
an existing record for `open-ledger.mpt.hr` has to be removed first.
