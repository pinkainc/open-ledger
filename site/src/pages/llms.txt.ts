import type { APIRoute } from 'astro';
import facts from '../data/facts.json';

const repo = 'https://github.com/pinkainc/open-ledger';
const raw = `${repo}/blob/main`;

export const GET: APIRoute = ({ site }) => {
  const s = site!;
  const u = (p: string) => new URL(p, s).href;
  const f = facts;
  const body = `# open-ledger

> Open-source (MIT) server that answers the Minka Ledger API the way Minka does: ${f.operations.confirmed} of ${f.operations.total} operations, each confirmed by a recorded exchange with the public Minka sandbox (spec ${f.operations.spec}). Independent project, not affiliated with or endorsed by Minka Inc.

## Site
- [English home page](${u('/en/')}): what it is, how compatibility is proven, how to run it
- [Hrvatska početna stranica](${u('/hr/')}): isto na hrvatskom
- [API coverage](${u('/en/coverage/')}): every resource and operation with its recording
- [Findings about the reference](${u('/en/findings/')}): ${f.findings.sections} findings and ${f.divergences.count} deliberate divergences

## Sources in the repository
- [README](${raw}/README.md): overview, run instructions, design, non-goals
- [COVERAGE.md](${raw}/COVERAGE.md): operation-by-operation coverage table
- [FINDINGS.md](${raw}/FINDINGS.md): observed behaviour of the reference implementation
- [divergences.json](${raw}/conformance/divergences.json): public register of deliberate differences
- [Repository](${repo})
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
