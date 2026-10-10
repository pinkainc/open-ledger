// Follow-up to `filters`, where `data.handle.$regex=^w` found no wallet although `w1`
// exists. What does `$regex` match: a regular expression, a LIKE pattern, a substring,
// case-insensitively? Wallets `w1`, `Wx`, `a.b` and `w%`; one list per pattern.
import { scenario } from './common.js'

const { sdk, step, create } = await scenario()
const s: any = sdk
for (const h of ['w1', 'Wx', 'a.b', 'w%']) await create('wallet', { handle: h })
for (const p of ['w1', 'w', '^w', 'w.*', '.*w.*', '^w1$', 'W', 'w%', '%w%', 'a.b', 'a\\.b', '[aw]']) await step(`wallet.list $regex ${p}`, () => s.wallet.list({ 'data.handle.$regex': p }))
await step('wallet.list $regex on custom', () => s.wallet.list({ 'data.custom.x.$regex': 'w' }))
