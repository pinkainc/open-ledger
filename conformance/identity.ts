// The operator's key: one Ed25519 pair that creates every ledger recorded on the
// sandbox, so the recordings can be tied to one person. It lives outside the repo
// (the secret must never be committed); run.sh record points OPEN_LEDGER_OPERATOR_KEY
// at it. Without the variable (check runs, tests) a fresh pair is made as before.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createKeyPair } from '@minka/ledger-sdk/crypto'

export type KeyPair = Awaited<ReturnType<typeof createKeyPair>>

export const defaultOperatorKeyFile = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'open-ledger', 'sandbox-operator.json')

export async function loadOrCreateOperatorKey(file: string): Promise<KeyPair> {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const key = await createKeyPair()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...key, created: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return key
}

/** The key a scenario creates its ledger with. */
export async function operatorKeyPair(): Promise<KeyPair> {
  const file = process.env.OPEN_LEDGER_OPERATOR_KEY
  if (!file) return createKeyPair()
  const { format, public: pub, secret } = await loadOrCreateOperatorKey(file)
  return { format, public: pub, secret }
}
