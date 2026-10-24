// Build-time readers for COVERAGE.md, FINDINGS.md and conformance/divergences.json.
// Nothing is copied into the repo: the files are read from the repository root on build.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { marked, Renderer } from 'marked';
import facts from '../data/facts.json';

// Astro runs with cwd = site/, the repository root is one level up.
const root = (p: string) => resolve(process.cwd(), '..', p);
const read = (p: string) => readFileSync(root(p), 'utf8');

export interface Operation { method: string; path: string; confirmed: boolean }
export interface ResourceCoverage { name: string; implemented: number; total: number; operations: Operation[] }

export function readCoverage(): ResourceCoverage[] {
  const rows = read('COVERAGE.md').split('\n').filter((l) => /^\| [a-z]/.test(l) && !l.startsWith('| Resource'));
  const out: ResourceCoverage[] = rows.map((row) => {
    const [name, impl, ops] = row.replace(/^\| /, '').replace(/ \|\s*$/, '').split(' | ');
    const m = /^(\d+)\/(\d+)$/.exec(impl);
    if (!name || !m) throw new Error(`COVERAGE.md: cannot parse row: ${row.slice(0, 80)}`);
    const operations = ops.split('<br>').map((o) => {
      const mm = /^`([A-Z]+) (\S+)` (✓)?$/.exec(o.trim());
      if (!mm) throw new Error(`COVERAGE.md: cannot parse operation "${o}" in ${name}`);
      return { method: mm[1], path: mm[2].replace(/\\!/g, '!'), confirmed: mm[3] === '✓' };
    });
    return { name, implemented: Number(m[1]), total: Number(m[2]), operations };
  });
  const n = out.reduce((a, r) => a + r.operations.length, 0);
  const confirmed = out.reduce((a, r) => a + r.operations.filter((o) => o.confirmed).length, 0);
  if (n !== facts.operations.total) throw new Error(`COVERAGE.md has ${n} operations, facts.json says ${facts.operations.total}`);
  if (confirmed !== facts.operations.confirmed) throw new Error(`COVERAGE.md confirms ${confirmed}, facts.json says ${facts.operations.confirmed}`);
  for (const r of out) if (r.operations.length !== r.total) throw new Error(`COVERAGE.md: ${r.name} lists ${r.operations.length}, header says ${r.total}`);
  if (out.length !== facts.resources.length) throw new Error(`COVERAGE.md has ${out.length} resources, facts.json ${facts.resources.length}`);
  return out;
}

export interface Divergence { fixture: string; exchanges: number[]; what: string; reference: string; ours: string; why: string }

export function readDivergences(): Divergence[] {
  const d = JSON.parse(read('conformance/divergences.json')) as Divergence[];
  if (d.length !== facts.divergences.count) throw new Error(`divergences.json has ${d.length}, facts.json says ${facts.divergences.count}`);
  return d;
}

// Raw HTML in the markdown (e.g. a stray `<intent>`) is shown as text, never injected.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const renderer = new Renderer();
renderer.html = ({ text }) => esc(text);
renderer.table = function (token) {
  return `<div class="table-scroll" tabindex="0">${Renderer.prototype.table.call(this, token)}</div>`;
};

export interface FindingSection { id: string; date: string; title: string; html: string }

export function readFindings(): FindingSection[] {
  const parts = read('FINDINGS.md').split(/^## /m).slice(1);
  const out = parts.map((p, i) => {
    const nl = p.indexOf('\n');
    const heading = p.slice(0, nl).trim();
    const m = /^(\d{4}-\d{2}-\d{2}) — (.+)$/.exec(heading);
    if (!m) throw new Error(`FINDINGS.md: heading without date: ${heading}`);
    // Demote nothing: section bodies have no headings above ###; shift them to h3/h4.
    const body = p.slice(nl + 1).replace(/^(#{3,5}) /gm, '#$1 ');
    return { id: `f${i + 1}`, date: m[1], title: m[2], html: marked.parse(body, { renderer, gfm: true, async: false }) as string };
  });
  if (out.length !== facts.findings.sections) throw new Error(`FINDINGS.md has ${out.length} sections, facts.json says ${facts.findings.sections}`);
  return out;
}
