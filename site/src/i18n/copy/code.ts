// Commands and snippets shown on the page. Code is not translated; comments are
// (copy.running.commands). Ports come from facts.json.
import type { CommandId, Facts } from './types';

export const commands = (f: Facts): { id: CommandId; cmd: string }[] => [
  { id: 'install', cmd: 'npm install' },
  { id: 'check', cmd: 'npm run check' },
  { id: 'level', cmd: 'npm run conformance:check -- l1' },
  { id: 'db', cmd: 'scripts/dev-db.sh start' },
  { id: 'cli', cmd: 'scripts/cli-e2e.sh' },
  { id: 'start', cmd: 'DATABASE_URL=… npm start' },
];

/** From scripts/cli-e2e.sh (`server connect "$BASE"`) and conformance/scenarios/l0.ts. */
export const clientSnippets = (f: Facts) => ({
  cli: `minka server connect http://localhost:${f.ports.server}/api/v2`,
  sdk: `import { LedgerSdk } from '@minka/ledger-sdk'

const sdk = new LedgerSdk({
  server: 'http://localhost:${f.ports.server}/api/v2',
  ledger: 'my-ledger',
  // keyPair: the signer's key pair. Claim shape as in conformance/scenarios/l0.ts.
  secure: {
    iss: keyPair.public,
    sub: \`signer:\${keyPair.public}\`,
    aud: 'my-ledger',
    exp: 3600,
    kid: keyPair.public,
    keyPair,
  },
})`,
});
