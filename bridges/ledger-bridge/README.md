# ledger-bridge

A bridge between two Minka-compatible ledgers: either Minka's own or open-ledger, in any
combination. It is the "banking core" of
[cross-ledger payments](https://docs.minka.io/ledger/connecting-systems/cross-ledger-payments),
with the core being a ledger too.

```
 clearing ledger (upstream)                         bank ledger (downstream)
 ┌───────────────────────────┐   2PC calls          ┌────────────────────────────┐
 │ wallet mint, bridge: mint │ ───────────────────▶ │ treasury                   │
 │ account:1001@mint  ─┐     │   POST /v2/debits…   │ account:1001               │
 │ tel:1333 → forward ─┘     │                      │ transit (held debits)      │
 └───────────────────────────┘ ◀─────────────────── └────────────────────────────┘
          ▲ proofs (prepared/committed/aborted)          intents signed by the bridge key
```

| Upstream call | Downstream intent (handle) |
| --- | --- |
| prepare debit of `x@mint` | transfer `x → transit` (`<entry>-prepare`); `failed` if it is rejected |
| commit debit | destroy from `transit` (`<entry>-commit`) |
| abort debit | transfer `transit → x` (`<entry>-abort`), only if the prepare completed |
| prepare credit to `x@mint` | none: wallet `x` must exist, else `bridge.account-not-found` |
| commit credit | issue to `x` (`<entry>-commit`) |
| abort credit | none |

`mint` itself maps to the downstream `treasury`. Money crossing the boundary is destroyed
on one side and issued on the other, so **the bank ledger's supply always equals the
clearing ledger's `mint` balance**. The tests check it after concurrent random payments.

- **Who signs.** The bridge has one key. Upstream it is registered as the signer of the
  bridge, and its proofs report each phase on the intent (as `@minka/bridge-sdk` does).
  Downstream, the same key signs the intents, so the bank's records must grant it access.
- **Who may call.** A call is carried out only if its body carries a valid proof by the
  upstream ledger's `system` signer over the entry's hash (read once, or given as
  `trusted`). Anything else gets 401. Minka sends no token on 2PC calls; the proof is the
  credential.
- **Idempotency.** Downstream handles derive from the entry handle. A repeated call joins
  the run under way or finds the intent already made.
- **Restarts.** A commit or abort names only the entry. The bridge takes the entry from its
  prepare, or, if it has restarted, from the intent's proofs.
- **No loops.** The bridge only writes downstream, and the bank ledger must not have a
  bridge that leads back. Every wait is bounded.
- **The clearing ledger checks first.** A debit of `x@mint` is limited by the upstream
  `mint` balance before the bridge is asked (`core.limit-exceeded … for wallet mint`), so a
  bank can never send more than its position.

```ts
import { LedgerBridge } from './src/index.js'

const bridge = new LedgerBridge({
  handle: 'mint',
  keyPair, // { public, secret } ed25519, raw base64
  upstream: { server: 'https://ldg-stg.one/api/v2', ledger: 'clearing' },
  downstream: { server: 'http://127.0.0.1:4620/api/v2', ledger: 'mint-core' },
  wallet: 'mint',
})
await bridge.listen(4630) // register http(s)://<public address>/v2 as bridge `mint` upstream
```

Recorded against the Minka sandbox with two ledgers (`conformance/scenarios/l9.ts`). It
also runs between two open-ledger servers (`server/test/l9.test.ts`) and between
open-ledger and Minka in both directions (`conformance/scenarios/l9mixed.ts`).
