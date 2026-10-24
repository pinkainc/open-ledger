// Renders public/og-en.png and public/og-hr.png (1200x630) from src/data/facts.json.
// Needs `rsvg-convert` (librsvg) locally; the PNGs are committed, so CI/build does not.
// Run: npm run og   (after `npx tsx scripts/site-facts.ts` in the repo root when numbers changed).
// `--check` (in `npm run check` and the site build) needs no rsvg-convert: it rebuilds the
// SVG sources and compares their sha256 with scripts/og.sha256 (committed with the PNGs, not published),
// so a stale committed PNG fails the check instead of going out unnoticed.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const f = JSON.parse(readFileSync(join(root, 'src/data/facts.json'), 'utf8'));
const check = process.argv.includes('--check');
const stampFile = join(root, 'scripts/og.sha256');
const svgs = {};

const copy = {
  en: { head: 'A Minka-compatible ledger', sub: 'Open source, MIT', ops: 'operations confirmed by recording' },
  hr: { head: 'Ledger kompatibilan s Minkom', sub: 'Otvoreni kod, MIT', ops: 'operacija potvrđeno snimkom' },
};
for (const lang of ['en', 'hr']) {
  const c = copy[lang];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0f1b26"/>
<rect x="64" y="64" width="96" height="96" rx="18" fill="#1f5f8b"/>
<path d="M97 91v47h46" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
<text x="184" y="132" font-family="Menlo, Courier New, monospace" font-size="56" font-weight="700" fill="#ffffff">open-ledger</text>
<text x="64" y="320" font-family="Helvetica, Arial, sans-serif" font-size="76" font-weight="700" fill="#ffffff">${c.head}</text>
<text x="64" y="384" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#9fb6c8">${c.sub}</text>
<text x="64" y="530" font-family="Menlo, Courier New, monospace" font-size="120" font-weight="700" fill="#7cc4f0">${f.operations.confirmed}/${f.operations.total}</text>
<text x="64" y="580" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="#9fb6c8">${c.ops}</text>
</svg>`;
  svgs[lang] = svg;
}
const stamp = Object.entries(svgs)
  .map(([lang, svg]) => `${createHash('sha256').update(svg).digest('hex')}  og-${lang}.svg (source of og-${lang}.png)`)
  .join('\n') + '\n';

if (check) {
  let old = '';
  try { old = readFileSync(stampFile, 'utf8'); } catch {}
  if (old !== stamp) {
    console.error('OG images are stale (facts.json or the OG design changed): run `npm --prefix site run og` and commit public/og-*.png and scripts/og.sha256');
    process.exit(1);
  }
  console.log('OG images match facts.json');
} else {
  const tmp = mkdtempSync(join(tmpdir(), 'og-'));
  for (const [lang, svg] of Object.entries(svgs)) {
    const src = join(tmp, `og-${lang}.svg`);
    writeFileSync(src, svg);
    execFileSync('rsvg-convert', ['-w', '1200', '-h', '630', '-o', join(root, `public/og-${lang}.png`), src]);
    console.log(`public/og-${lang}.png`);
  }
  writeFileSync(stampFile, stamp);
  console.log('scripts/og.sha256');
}
