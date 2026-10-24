// Renders public/og-en.png and public/og-hr.png (1200x630) from src/data/facts.json.
// Needs `rsvg-convert` (librsvg) locally; the PNGs are committed, so CI/build does not.
// Run: npm run og   (after `npm run facts` in the repo root when numbers changed).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const f = JSON.parse(readFileSync(join(root, 'src/data/facts.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'og-'));

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
  const src = join(tmp, `og-${lang}.svg`);
  writeFileSync(src, svg);
  execFileSync('rsvg-convert', ['-w', '1200', '-h', '630', '-o', join(root, `public/og-${lang}.png`), src]);
  console.log(`public/og-${lang}.png`);
}
