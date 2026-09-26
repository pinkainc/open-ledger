// Calls from the ledger to bridges (docs: about-bridges; recorded in l5).
//
//   prepare  POST {server}/debits | /credits          body: signed entry
//   commit   POST {server}/<schema>s/<entry>/commit    body: signed command
//   abort    POST {server}/<schema>s/<entry>/abort     body: signed command
//   status   PUT  {server}/intents/<intent>            body: the intent (statuses trait)
//
// `server` already ends in /v2. A bridge answers 202 and reports later with a proof on
// the intent. A call that fails is retried — from 1 s, 20 % longer each time, at most
// an hour apart (about-bridges) — until it succeeds; 501 stops it for good
// (inspect-event-deliveries). The bridge must treat a repeated call as a no-op: the
// entry handle (and action) is the idempotency key.
export type BridgeCall = { bridge: string; server: string; method: 'POST' | 'PUT'; path: string; body: unknown }

export type BridgeOptions = {
  /** First retry delay in ms; tests shorten it. */
  retryMs?: number
  /** Per-call timeout in ms. */
  timeoutMs?: number
}

export class Bridges {
  private closed = false
  private readonly timers = new Map<NodeJS.Timeout, () => void>()
  private readonly retryMs: number
  private readonly timeoutMs: number

  constructor({ retryMs = 1_000, timeoutMs = 60_000 }: BridgeOptions = {}) {
    this.retryMs = retryMs
    this.timeoutMs = timeoutMs
  }

  /** Delivers one call, retrying until the bridge accepts it. Resolves when it did (or gave up). */
  async deliver(call: BridgeCall): Promise<boolean> {
    let delay = this.retryMs
    for (;;) {
      if (this.closed) return false
      const status = await this.attempt(call)
      if (status >= 200 && status < 300) return true
      if (status === 501) return false
      await this.sleep(delay)
      delay = Math.min(delay * 1.2, 3_600_000)
    }
  }

  /** Delivers calls one after another (prepare: debits, then credits; abort: reverse). */
  async inOrder(calls: BridgeCall[]) {
    for (const c of calls) await this.deliver(c)
  }

  close() {
    this.closed = true
    for (const [t, wake] of this.timers) {
      clearTimeout(t)
      wake()
    }
    this.timers.clear()
  }

  private async attempt(call: BridgeCall): Promise<number> {
    try {
      const res = await fetch(`${call.server}${call.path}`, {
        method: call.method,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
        body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      await res.arrayBuffer().catch(() => undefined)
      return res.status
    } catch {
      return 0
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t)
        resolve()
      }, ms)
      t.unref()
      this.timers.set(t, resolve)
    })
  }
}
