// Calls from the ledger to bridges (docs: about-bridges; recorded in l5, l6, events).
//
//   prepare  POST {server}/debits | /credits          body: signed entry
//   commit   POST {server}/<schema>s/<entry>/commit    body: signed command
//   abort    POST {server}/<schema>s/<entry>/abort     body: signed command
//   status   PUT  {server}/intents/<intent>            body: the intent (statuses trait)
//
// `server` already ends in /v2. A bridge answers 202 and reports later with a proof on
// the intent. Each call is a delivery (inspect-event-deliveries): a record written with
// the step that caused it, then attempted until the bridge accepts — retried from 1 s,
// 20 % longer each time, at most an hour apart (about-bridges). 501 cancels it for
// good. Every attempt's outcome goes to `onAttempt`, which signs it into the record.
// The bridge must treat a repeated call as a no-op: the entry handle (and action) is
// the idempotency key.
export type BridgeCall = {
  bridge: string
  server: string
  method: 'POST' | 'PUT'
  path: string
  body: unknown
  /** The delivery record this call is (`$evd`), once enqueued. */
  ledger?: string
  delivery?: string
}

/** What one attempt came to, as the delivery's proof records it. */
export type Outcome =
  | { status: 'delivered'; detail: { httpStatus: number } }
  | { status: 'failed'; reason: string; detail: Record<string, unknown> }
  | { status: 'cancelled'; reason: string }

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
  /** The loop delivering each delivery handle; a retry replaces it. */
  private readonly running = new Map<string, { cancelled: boolean }>()
  onAttempt?: (call: BridgeCall, outcome: Outcome) => Promise<void>

  constructor({ retryMs = 1_000, timeoutMs = 60_000 }: BridgeOptions = {}) {
    this.retryMs = retryMs
    this.timeoutMs = timeoutMs
  }

  /**
   * Delivers one call, retrying until the bridge accepts it. Resolves true when it did,
   * false when it was cancelled (501), replaced by a retry, or the ledger shut down.
   */
  async deliver(call: BridgeCall): Promise<boolean> {
    const token = { cancelled: false }
    if (call.delivery) {
      const previous = this.running.get(call.delivery)
      if (previous) previous.cancelled = true
      this.running.set(call.delivery, token)
    }
    try {
      let delay = this.retryMs
      for (;;) {
        if (this.closed || token.cancelled) return false
        const outcome = await this.attempt(call)
        if (token.cancelled) return false
        await this.onAttempt?.(call, outcome)
        if (outcome.status === 'delivered') return true
        if (outcome.status === 'failed' && outcome.detail.httpStatus === 501) {
          await this.onAttempt?.(call, { status: 'cancelled', reason: 'delivery.permanent-failure' })
          return false
        }
        await this.sleep(delay)
        delay = Math.min(delay * 1.2, 3_600_000)
      }
    } finally {
      if (call.delivery && this.running.get(call.delivery) === token) this.running.delete(call.delivery)
    }
  }

  /** Delivers calls one after another. */
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

  // Recorded: a non-2xx answer is `delivery.target-rejected` with the status; the body
  // appears only for 501 (as "{}" when the bridge sent none) — kept as observed.
  private async attempt(call: BridgeCall): Promise<Outcome> {
    try {
      const res = await fetch(`${call.server}${call.path}`, {
        method: call.method,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
        body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const text = await res.text().catch(() => '')
      if (res.status >= 200 && res.status < 300) return { status: 'delivered', detail: { httpStatus: res.status } }
      const detail: Record<string, unknown> = { httpStatus: res.status }
      if (res.status === 501) detail.body = (text || '{}').slice(0, 500)
      return { status: 'failed', reason: 'delivery.target-rejected', detail }
    } catch (e: any) {
      const code = e?.cause?.code ?? e?.code
      return { status: 'failed', reason: 'delivery.target-unreachable', detail: { message: String(e?.cause?.message ?? e?.message ?? e), ...(code ? { code } : {}) } }
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
