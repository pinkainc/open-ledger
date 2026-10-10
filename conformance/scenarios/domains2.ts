// Access inherited through domains (securing-the-ledger/about-domains, "Domain
// security"): the rules of a domain apply to the records in it and to its subdomains,
// and the ledger's rules to everything. The ledger here is not open: only the operator
// may change and read records, everyone may enter. Domain `a` grants key A everything, its
// subdomain `c@a` grants key C everything, domain `b` grants key B wallets only. Records
// carry no rules of their own, so what decides is the domain.
//
// Reads: domain `a` also lets A read (a bearer rule), and a list by A should then
// leave out what A may not read — the first recording of a record hidden from a list.
import { LedgerSdk } from '@minka/ledger-sdk'
import { createKeyPair } from '@minka/ledger-sdk/crypto'
import { scenario } from './common.js'

const { sdk, keyPair, step, LEDGER, BASE } = await scenario({
  access: (op) => [
    { action: 'any', signer: { public: op } },
    { action: 'any', record: 'any', signer: { public: op } },
    { action: 'access' },
    { action: 'read', record: 'any', bearer: { $signer: { public: op } } },
  ],
})
const s: any = sdk
const A = await createKeyPair()
const B = await createKeyPair()
const C = await createKeyPair()
const X = await createKeyPair()
const sdkOf = (k: any): any =>
  new LedgerSdk({ server: BASE, ledger: LEDGER, secure: { iss: k.public, sub: `signer:${k.public}`, aud: LEDGER, exp: 3600, createHsh: false, kid: k.public, keyPair: k } as any })
const as = { op: s, A: sdkOf(A), B: sdkOf(B), C: sdkOf(C), X: sdkOf(X) }
const keys = { op: keyPair, A, B, C, X }
type Who = keyof typeof keys

const owner = { action: 'any', signer: { public: keyPair.public } }
const make = (who: Who, client: string, data: Record<string, unknown>, domain?: string) =>
  step(`${who} ${client}.create ${data.handle}${domain ? ` in ${domain}` : ''}`, () =>
    as[who][client].init().data(data).hash().sign([{ keyPair: keys[who], ...(domain ? { custom: { domain } } : {}) }]).send(),
  )

await make('op', 'domain', { handle: 'a', access: [owner, { action: 'any', record: 'any', signer: { public: A.public } }, { action: 'read', record: 'any', bearer: { $signer: { public: A.public } } }] })
await make('op', 'domain', { handle: 'c@a', access: [owner, { action: 'any', record: 'any', signer: { public: C.public } }] })
await make('op', 'domain', { handle: 'b', access: [owner, { action: 'any', record: 'wallet', signer: { public: B.public } }] })
await make('op', 'symbol', { handle: 'usd', factor: 100, access: [owner] })

// Creating in a domain.
await make('A', 'wallet', { handle: 'wa@a' })
await make('A', 'wallet', { handle: 'wa2' }, 'a')
await make('A', 'wallet', { handle: 'wc@c@a' })
await make('A', 'wallet', { handle: 'wc2' }, 'c@a')
await make('A', 'wallet', { handle: 'root-a' })
await make('A', 'wallet', { handle: 'wb-a@b' })
await make('C', 'wallet', { handle: 'wc3' }, 'c@a')
await make('C', 'wallet', { handle: 'wa-c@a' })
await make('C', 'wallet', { handle: 'root-c' })
await make('B', 'wallet', { handle: 'wb@b' })
await make('B', 'symbol', { handle: 'eur@b', factor: 100 })
await make('X', 'wallet', { handle: 'wx@a' })
await make('op', 'wallet', { handle: 'wo@c@a' })
await make('A', 'domain', { handle: 'd@a' })
await make('C', 'domain', { handle: 'e@a' })

// Changing a record in a domain: the record grants nothing, its domain decides.
const upd = (who: Who, handle: string) =>
  step(`${who} wallet.update ${handle}`, async () => {
    const cur: any = (await s.wallet.read(handle)).response.data
    return as[who].wallet.from(cur).data({ custom: { by: who } }).hash().sign([{ keyPair: keys[who] }]).send()
  })
await upd('A', 'wc3')
await upd('C', 'wa@a')
await upd('B', 'wb@b')
await upd('X', 'wa@a')

// Reads and lists.
for (const who of ['A', 'C', 'X'] as Who[]) {
  await step(`${who} wallet.read wa@a`, () => as[who].wallet.read('wa@a'))
  await step(`${who} wallet.read wc3`, () => as[who].wallet.read('wc3'))
  await step(`${who} wallet.read wb@b`, () => as[who].wallet.read('wb@b'))
}
await step('A wallet.list', () => as.A.wallet.list())
await step('A wallet.list meta.domain=a', () => as.A.wallet.list({ 'meta.domain': 'a' }))
await step('C wallet.list', () => as.C.wallet.list())
await step('op wallet.list', () => s.wallet.list())

// Moving money in a domain: A funds and moves between its own wallets.
await step('A intent.create issue to wa@a', () =>
  as.A.intent
    .init()
    .data({ handle: 'i-a', claims: [{ action: 'issue', target: { handle: 'wa@a' }, symbol: { handle: 'usd' }, amount: 5 }] })
    .hash()
    .sign([{ keyPair: A, custom: { domain: 'a' } }])
    .send(),
)
await new Promise((r) => setTimeout(r, 2000))
await step('intent.read i-a', () => s.intent.read('i-a'))
