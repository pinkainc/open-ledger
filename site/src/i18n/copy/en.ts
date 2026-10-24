// English page copy. Engineering register: conclusion first, no drama, numbers only
// from facts.json. Sources per claim: site/CONTENT.md.
import type { Copy } from './types';
import { date, num, range } from './format';

const d = (iso: string) => date('en', iso);
const n = (x: number) => num('en', x);

export const en = {
  meta: {
    title: 'open-ledger: a Minka-compatible ledger (MIT)',
    description: (f) =>
      `An open-source (MIT) server that answers the Minka Ledger API the way Minka does: ${f.operations.confirmed} of ${f.operations.total} operations, each confirmed by a recorded exchange with the public sandbox.`,
  },

  hero: {
    lead: [
      'open-ledger is a server that answers the Minka Ledger API the way Minka does. The official `@minka/ledger-sdk` and the `minka` CLI work against it unchanged. It is open source under the MIT licence.',
      'The model is S3: Amazon’s implementation is closed and its API is the contract, which MinIO, Ceph and R2 implement on their own internals. Minka is closed in the same way, and what is public is the API its clients speak. Behind that API, the design of open-ledger is independent.',
    ],
    buttons: {
      github: 'Source on GitHub',
      run: 'Run it locally',
      proof: 'How compatibility is measured',
    },
  },

  numbers: {
    intro: 'All figures are generated from the repository by `scripts/site-facts.ts`; `npm run check` fails when they are out of date.',
    items: [
      {
        value: (f) => `${f.operations.confirmed}/${f.operations.total}`,
        label: (f) =>
          `operations of Minka’s OpenAPI spec ${f.operations.spec} implemented, each confirmed by a recorded exchange`,
      },
      {
        value: (f) => String(f.exchanges.total),
        label: (f) =>
          `exchanges recorded against the public sandbox: ${f.exchanges.client} client requests and ${f.exchanges.bridge} calls to bridges`,
      },
      {
        value: (f) => String(f.tests.postgres),
        label: (f) => `unit tests on Postgres, in ${f.tests.files} files`,
      },
      {
        value: (f) => f.version.sandbox,
        label: 'sandbox version of the latest recordings; the server reports the same version',
      },
      {
        value: (f) => String(f.divergences.count),
        label: (f) =>
          `documented, deliberate divergences from the reference, in ${f.divergences.fixtures} fixtures`,
      },
      {
        value: (f) => String(f.footprint.ledgers),
        label: 'ledgers left on the public sandbox by recording runs, each logged; the sandbox cannot delete them',
      },
    ],
  },

  proof: {
    intro:
      'Compatibility is measured against recordings of the reference, not inferred from documentation. The public Minka sandbox is recorded once, and open-ledger is then compared with that recording on every check.',
    steps: [
      'A scenario in `conformance/scenarios/` drives the official SDK, so every request is exactly what a real client sends.',
      'A recording proxy, `conformance/proxy.ts`, writes every exchange with the sandbox verbatim to `conformance/fixtures/*.reference.jsonl`.',
      'The same scenario runs against open-ledger through the same proxy and produces `.rec/*.candidate.jsonl`.',
      '`conformance/compare.ts` checks status, body shape and every value, and reports how many exchanges match out of how many were recorded.',
    ],
    placeholders:
      'Values that change on every run (moments, luids, keys, hashes, signatures) are replaced by placeholders numbered in order of first appearance. A value that appears twice in the reference must therefore appear twice in our answer too, so identity is still checked. The wording of an error `detail` is compared but only reported.',
    bridges: (f) =>
      `For two-phase commit the scenario runs its own bridge, which the sandbox reaches through a public tunnel. The calls the reference makes to that bridge are recorded as well: ${f.fixtures.bridge} bridge fixtures next to ${f.fixtures.reference} client fixtures.`,
    divergences: (f) =>
      `Where the reference has a defect, open-ledger deliberately behaves differently, and each such case is listed in \`conformance/divergences.json\` with what happens, what the reference does, what open-ledger does and why. The comparator reports these exchanges instead of failing them. The register has ${f.divergences.count} entries in ${f.divergences.fixtures} fixtures.`,
    example:
      'Example from L3: an issue that would take a wallet above its `maxBalance` stays `committed` indefinitely on the reference; open-ledger rejects it before preparing. Recorded reason: an intent that can never reach a final status is a defect, not a contract.',
    precedence:
      'Where the sandbox cannot show a behaviour, Minka’s public documentation is the specification. Where the documentation and the sandbox disagree, the sandbox wins.',
    diagram: {
      sdk: 'Official SDK',
      proxy: 'Recording proxy',
      sandbox: 'Minka sandbox',
      ours: 'open-ledger',
      reference: 'reference recording',
      candidate: 'candidate recording',
      compare: 'compare',
      exceptions: 'divergences.json',
    },
  },

  levels: {
    intro:
      'Each level is a set of scenarios recorded against the sandbox and replayed against open-ledger on both stores, in-memory and Postgres. Counts are matching exchanges out of recorded ones.',
    columns: {
      level: 'Level',
      scope: 'Scope',
      client: 'Client exchanges',
      bridge: 'Bridge calls',
      differ: 'Deliberately differ',
      fixtures: 'Fixtures',
    },
    scope: (l) => l.scope,
    notes: [
      'L2 (atomicity of several claims in one intent) has no scenario of its own; the L1 and L3 scenarios cover it.',
      'Exchanges that deliberately differ are the entries of `divergences.json` for that fixture. They are reported, not failed.',
    ],
  },

  interop: {
    paragraphs: [
      '`bridges/ledger-bridge` connects two ledgers the way cross-ledger payments connect a clearing house and a bank. The clearing ledger sees it as the bridge of the bank’s wallet, and it carries every two-phase-commit call into the bank’s own ledger as intents. It does not depend on whose ledger is on either side.',
      (f) =>
        `\`conformance/scenarios/l9mixed.ts\` runs it in both directions against the public Minka sandbox: once with the sandbox as the clearing house and open-ledger as the bank’s ledger, once the other way round. Each direction covers a top-up, payments in and out, a refused debit and an abort after a prepared debit, and ends with the bank’s supply equal to its position in the clearing ledger: ${f.interop.supply} = ${f.interop.supply}.`,
      (f) =>
        `Both directions are recorded. \`npm run check\` replays them against open-ledger alone: ${f.interop.mixed.client}/${f.interop.mixed.client} client exchanges and ${f.interop.mixed.bridge}/${f.interop.mixed.bridge} bridge calls match.`,
      'The official `minka` CLI runs a complete flow against the server in `scripts/cli-e2e.sh`, which is part of `npm run check`: connect, signer, ledger, symbol, wallets, issue, transfer, balances and filtered lists.',
    ],
    docsLink: 'Minka documentation: cross-ledger payments',
  },

  coverage: {
    teaser: (f) => {
      const top = [...f.resources]
        .sort((a, b) => b.total - a.total)
        .slice(0, 4)
        .map((r) => `${r.name} (${r.total})`)
        .join(', ');
      return `All ${f.operations.total} operations of Minka’s OpenAPI spec ${f.operations.spec} are implemented, in ${f.resources.length} resources, and ${f.operations.confirmed} are confirmed by a recorded exchange. The largest resources are ${top}.`;
    },
    link: 'Coverage by resource and operation',
    pageIntro: [
      (f) =>
        `This table is generated by \`conformance/coverage.ts\` from Minka’s published OpenAPI spec ${f.operations.spec}. A check mark means that a reference exchange for the operation is recorded in \`conformance/fixtures/\`.`,
      'The server also answers `GET /api/v2`, which `minka server connect` reads. It is not part of the spec.',
    ],
  },

  running: {
    requirements: (f) =>
      `Requires Node.js ${f.node.engine}. Postgres is optional: without \`DATABASE_URL\` the server uses the in-memory store, and every level passes on both.`,
    commandsIntro: 'From a clone of the repository:',
    commands: {
      install: 'install dependencies',
      check: 'everything: typecheck, tests, conformance, both stores',
      level: 'one level against the local server',
      db: (f) => `project-local Postgres on :${f.ports.devPostgres}, prints DATABASE_URL`,
      cli: (f) => `the minka CLI end to end against a fresh server on :${f.ports.cliE2e}`,
      start: (f) => `server on :${f.ports.server} (memory store without DATABASE_URL)`,
    },
    envIntro: 'Settings are environment variables:',
    env: {
      DATABASE_URL: 'Postgres connection; the in-memory store is used without it',
      PORT: (f) => `listen port (${f.ports.server})`,
      PUBLIC_URL:
        'the public address, with `SERVER_HANDLE` what `GET /api/v2` reports; required behind a reverse proxy (see Known gaps)',
      OPEN_LEDGER_MASTER_KEY:
        '32 bytes, base64; seals the secrets that bridge `secure` rules refer to. Without it each process generates its own key, secrets are lost on restart, and the server warns',
      OPEN_LEDGER_DELIVERY_MAX_RETRIES: 'retries of a call to a bridge before it is cancelled (5, as on the reference)',
      OPEN_LEDGER_LOG: 'one line per request on stderr',
    },
    clients: (f) =>
      `The official clients only need the server address, \`http://localhost:${f.ports.server}/api/v2\`. The CLI connects with \`minka server connect\`; the SDK takes the same address as \`server\`.`,
    record:
      'Re-recording the reference (`npm run conformance:record`) creates one ledger on the public sandbox per run, and the sandbox cannot delete ledgers. Record only when a scenario changes; checking against the existing recordings does not touch the sandbox.',
    copy: 'Copy',
    copied: 'Copied',
  },

  design: {
    stores: 'There are two stores, Postgres and in-memory. Every level of the conformance suite passes on both.',
    serialisation: (f) =>
      `Intents of one ledger are processed one at a time, under an advisory lock in Postgres. Measured with \`scripts/bench.ts\` on a local Postgres on ${d(f.bench.measured)} (${f.bench.transfers} transfers between disjoint wallet pairs): ${range(f.bench.perSecond.oneLedger)} transfers/s on one ledger, ${range(f.bench.perSecond.fourLedgers)}/s over four ledgers, ${range(f.bench.perSecond.sixteenLedgers)}/s over sixteen. Per-wallet locking was measured and dropped: a ceiling about twice as high does not justify the risk.`,
    invariantsIntro: 'Unit tests check invariants that the reference cannot show from outside:',
    invariants: [
      'conservation of supply over a random sequence of intents, compared against a model;',
      'no overdraft under 50 concurrent transfers;',
      'two processes sharing one Postgres;',
      'recovery of intents left pending by a process that crashed.',
    ],
    lineCoverage: (f) =>
      `Line coverage of \`server/src\`: ${n(f.lineCoverage.lines)} % of lines, ${n(f.lineCoverage.branches)} % of branches and ${n(f.lineCoverage.functions)} % of functions, measured on ${d(f.lineCoverage.measured)} at commit \`${f.lineCoverage.commit}\`. It is not re-measured on every commit.`,
    gapsTitle: 'Known gaps',
    gaps: [
      '`hsh` needs the public address. The claim binds a token to the method, the absolute URL and the body as the client saw them. Behind a reverse proxy, set `PUBLIC_URL` to the `…/api/v2` address clients use; otherwise every token with `hsh` is refused, just as the reference refuses a token hashed over any address but its own.',
      'Serialisation is per ledger, so throughput within one ledger is bounded by the figures above.',
    ],
    backlog:
      'Not implemented: `schedule` and `layout` policies, in-flight runs of the `ledger-bridge` adapter, fewer round trips per intent, and an executor for DTC policies, which waits until the sandbox executes them.',
  },

  nonGoals: {
    paragraphs: [
      'An open-source ledger does not open a bank. Licensing, capital, AML/KYC, sanctions screening and access to payment schemes are the larger part of that problem, and none of them is in this repository. open-ledger is a core banking substrate that a licensed institution can run.',
      'Minka’s text, code and name are not copied. The API is implemented from observed behaviour and public documentation. The `minka` CLI (UNLICENSED) is used as a client, and its bundle was read to learn the token claims it sends; none of its code is reused. The SDK (MIT) is a development dependency of the conformance suite.',
    ],
  },

  findings: {
    teaser: [
      (f) =>
        `\`FINDINGS.md\` records how the reference ledger behaves on the public sandbox, and how each behaviour was established. It has ${f.findings.sections} dated sections, from ${d(f.findings.firstDate)} to ${d(f.findings.lastDate)}, newest first.`,
      'Topics include aborting before the bridge confirms, two ledgers joined by a bridge, access inherited through domains, `hsh` and OAuth, and the reports protocol.',
    ],
    link: 'Findings and the divergence register',
    pageIntro: [
      'Each finding states what the reference does and how that was established. Newest first.',
      (f) =>
        `The second part of the page is \`conformance/divergences.json\`: ${f.divergences.count} places where open-ledger deliberately behaves differently from the reference, each with what the reference does, what open-ledger does and why.`,
    ],
    languageNote: '',
  },
} satisfies Copy;
