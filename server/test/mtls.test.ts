// `mtls` secure rules (about-bridges): the ledger presents the rule's certificate and
// key on calls to an https bridge. The reference makes no call at all for such a bridge
// (recorded, secure2; divergences.json), and a tunnel would not show a client
// certificate anyway, so this is tested against a local bridge that requires one.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { Bridges, RuleError, type BridgeCall } from '../src/bridges.js'

const dir = mkdtempSync(join(tmpdir(), 'open-ledger-mtls-'))
const pair = (name: string, subject: string, san?: string) => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', subject, ...(san ? ['-addext', `subjectAltName=${san}`] : []), '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`)], { stdio: 'ignore' })
  return { cert: readFileSync(join(dir, `${name}.crt`), 'utf8'), key: readFileSync(join(dir, `${name}.key`), 'utf8') }
}

describe('mtls calls to a bridge', () => {
  const server = pair('server', '/CN=bridge', 'IP:127.0.0.1')
  const client = pair('client', '/CN=ledger-client')
  const stranger = pair('stranger', '/CN=someone-else')
  let https: Server
  let url = ''
  const seen: string[] = []
  before(async () => {
    // Trusts the one client certificate, and refuses a connection without it.
    https = createServer({ ...server, ca: client.cert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      seen.push(((req.socket as TLSSocket).getPeerCertificate().subject as any)?.CN)
      req.resume()
      req.on('end', () => {
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((r) => https.listen(0, '127.0.0.1', r))
    url = `https://127.0.0.1:${(https.address() as any).port}/v2`
  })
  after(() => https.close())

  const call = (): BridgeCall => ({ bridge: 'mt', server: url, method: 'POST', path: '/credits', body: { handle: 'e1' } })
  const outcomes = (b: Bridges) => {
    const out: any[] = []
    b.onAttempt = async (_c, o) => void out.push(o)
    return out
  }

  test('the rule\'s certificate is presented, and the bridge accepts the call', async () => {
    const b = new Bridges({ retryMs: 5, ca: server.cert })
    const out = outcomes(b)
    b.authorize = async () => ({ headers: { 'x-api-key': 'k' }, tls: client })
    assert.equal(await b.deliver(call()), true)
    assert.deepEqual(out, [{ status: 'delivered', detail: { httpStatus: 202 } }])
    assert.equal(seen.at(-1), 'ledger-client')
    b.close()
  })

  test('without the certificate, or with another, the bridge refuses the connection', async () => {
    for (const tls of [undefined, stranger]) {
      const b = new Bridges({ retryMs: 1, maxRetries: 1, ca: server.cert })
      const out = outcomes(b)
      b.authorize = async () => ({ headers: {}, ...(tls ? { tls } : {}) })
      assert.equal(await b.deliver(call()), false)
      assert.equal(out[0].reason, 'delivery.target-unreachable')
      assert.equal(out.at(-1).reason, 'delivery.retry-cap-exhausted')
      b.close()
    }
  })

  test('a bridge whose certificate is not trusted is not called', async () => {
    const b = new Bridges({ retryMs: 1, maxRetries: 0 })
    const out = outcomes(b)
    b.authorize = async () => ({ headers: {}, tls: client })
    assert.equal(await b.deliver(call()), false)
    assert.equal(out[0].reason, 'delivery.target-unreachable')
    b.close()
  })

  test('a rule that cannot be applied makes no call: unexpected-error without detail, then the cap', async () => {
    const b = new Bridges({ retryMs: 1, maxRetries: 5 })
    const out = outcomes(b)
    const before = seen.length
    b.authorize = async () => {
      throw new RuleError("No handler found for security rule schema 'x' in bridge 'mt' (rule #0)")
    }
    const c = call()
    assert.equal(await b.deliver(c), false)
    assert.equal(seen.length, before)
    assert.deepEqual(out.slice(0, 6), Array(6).fill({ status: 'failed', reason: 'delivery.unexpected-error' }))
    assert.deepEqual(out[6], { status: 'cancelled', reason: 'delivery.retry-cap-exhausted' })
    assert.equal(c.ruleError, "No handler found for security rule schema 'x' in bridge 'mt' (rule #0)")
    b.close()
  })
})
