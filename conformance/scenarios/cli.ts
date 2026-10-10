// The official `minka` CLI as a conformance level (TODO E2E): one flow of CLI commands
// (conformance/cli-flow.sh) against the sandbox when recording and against our server
// when checking, through the recording proxy, so the requests the CLI makes and the
// answers it gets are compared like any scenario's. The CLI signs with the operator
// key, imported as a PEM, so the ledger it creates is the operator's like every other.
//
// `minka bridge events list|show|retry` run against a bridge that answers every call
// 501: a delivery is cancelled after one attempt, and a retry cancels it again.
//
// needs-bridge — run.sh opens a tunnel for the reference when a scenario says this.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateKey } from 'node:crypto'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { startBridges } from '../bridge.js'
import { operatorKeyPair } from '../identity.js'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4610/api/v2'
const RUN = process.env.RUN ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14)
const LEDGER = `open-ledger-conf-${RUN}`
const key = await operatorKeyPair()
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const pem = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(key.secret, 'base64')]), format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' })

const home = mkdtempSync(join(tmpdir(), 'open-ledger-cli-'))
const bridges = await startBridges({
  port: Number(process.env.BRIDGE_PORT ?? 4630),
  out: process.env.BRIDGE_OUT ?? '.rec/cli.bridge.jsonl',
  ledger: LEDGER,
  server: process.env.DIRECT ?? BASE,
  bridges: [{ handle: 'bank1', keyPair: await createKeyPair(), decide: () => ({ httpWhile: 501, while: () => true, then: { status: 'prepared' } }) }],
})
try {
  writeFileSync(join(home, 'operator.pem'), pem, { mode: 0o600 })
  // Not spawnSync: the bridge answers from this process's event loop.
  const child = spawn('conformance/cli-flow.sh', [], {
    env: { ...process.env, HOME: home, MINKA_PASS: `cli-${RUN}`, BASE, LEDGER, SIGNER_PEM: join(home, 'operator.pem'), BRIDGE_URL: process.env.BRIDGE_URL ?? 'http://127.0.0.1:4630/v2', CLI_LOG: '.rec/cli-flow.log' },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  await new Promise((resolve) => child.on('exit', resolve))
} finally {
  await bridges.close()
  rmSync(home, { recursive: true, force: true })
}
