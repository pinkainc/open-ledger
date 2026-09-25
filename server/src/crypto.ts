// Hashing and signing exactly as the Minka wire protocol defines them.
//
// Every rule here was checked against recorded sandbox traffic, not only read from
// /ledger/securing-the-ledger/hash-and-sign-requests:
//   hash   = sha256(JCS(data))                      hex
//   digest = sha256(hash + JCS(custom) | '')        hex
//   result = ed25519(digest bytes)                  base64
// Keys travel as raw 32-byte ed25519 values in base64 ("ed25519-raw").
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import stringify from 'safe-stable-stringify'

export const canonical = (value: unknown): string => stringify(value) ?? ''

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

export const hashData = (data: unknown): string => sha256(canonical(data))

export const digestFor = (hash: string, custom?: Record<string, unknown>): string =>
  sha256(hash + (custom ? canonical(custom) : ''))

export type KeyPair = { public: string; secret: string; format: 'ed25519-raw' }

// DER prefixes that wrap a raw ed25519 key into SPKI / PKCS#8 for node:crypto.
const SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')

export function publicKeyObject(raw: string) {
  return createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' })
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI.length)
  const sec = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8.length)
  return { public: pub.toString('base64'), secret: sec.toString('base64'), format: 'ed25519-raw' }
}

export function signDigest(digest: string, keyPair: KeyPair): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(keyPair.secret, 'base64')]), format: 'der', type: 'pkcs8' })
  return sign(null, Buffer.from(digest, 'hex'), key).toString('base64')
}

export function verifyDigest(digest: string, publicRaw: string, result: string): boolean {
  try {
    return verify(null, Buffer.from(digest, 'hex'), publicKeyObject(publicRaw), Buffer.from(result, 'base64'))
  } catch {
    return false
  }
}

export type Proof = {
  method: string
  public: string
  digest: string
  result: string
  custom?: Record<string, unknown>
  origin?: string
  signer?: string
}

/** A proof as the ledger itself produces it: signed by a server signer, tagged with its handle. */
export function serverProof(hash: string, custom: Record<string, unknown>, keyPair: KeyPair, signer: string): Proof {
  const digest = digestFor(hash, custom)
  return {
    custom,
    digest,
    method: 'ed25519-v2',
    origin: 'key-pair',
    public: keyPair.public,
    result: signDigest(digest, keyPair),
    signer,
  }
}
