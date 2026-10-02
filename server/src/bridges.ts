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
// 20 % longer each time, at most an hour apart (about-bridges), five times (recorded,
// secure: six attempts, then `cancelled delivery.retry-cap-exhausted`). 501 cancels it
// at once. The last failed attempt carries the bridge's answer as `detail.body`
// (`"{}"` for none). Every attempt's outcome goes to `onAttempt`, which signs it into
// the record. The bridge must treat a repeated call as a no-op: the entry handle (and
// action) is the idempotency key.
//
// Each attempt carries the headers the bridge's `secure` rules give (`authorize`),
// worked out afresh: the reference asks an OAuth2 token endpoint before every call.
export type BridgeCall = {
  bridge: string
  server: string
  method: 'POST' | 'PUT'
  path: string
  body: unknown
  /** The delivery record this call is (`$evd`), once enqueued. */
  ledger?: string
  delivery?: string
  /**
   * Why the call has nowhere to go: an effect naming a bridge that does not exist
   * (recorded, effects). Each attempt fails `delivery.unexpected-error` with this as
   * the message, and the delivery is cancelled after ten.
   */
  unreachable?: string
  /** The effect whose event this is; its deliveries keep no answer body (recorded, effects). */
  effect?: string
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
  /** Retries after the first attempt before giving up; the reference's default is 5. */
  maxRetries?: number
}

// Retries of a call that fails inside the ledger rather than at the target (recorded,
// effects: ten failed attempts, then cancelled).
const UNEXPECTED_RETRIES = 9

export class Bridges {
  private closed = false
  private readonly timers = new Map<NodeJS.Timeout, () => void>()
  private readonly retryMs: number
  private readonly timeoutMs: number
  /** The loop delivering each delivery handle; a retry replaces it. */
  private readonly running = new Map<string, { cancelled: boolean }>()
  private readonly maxRetries: number
  onAttempt?: (call: BridgeCall, outcome: Outcome) => Promise<void>
  /** An attempt begins (the delivery is `running`). */
  onStart?: (call: BridgeCall) => Promise<void>
  /** Headers for one attempt, from the bridge's `secure` rules; throws when they cannot be had. */
  authorize?: (call: BridgeCall) => Promise<Record<string, string>>

  constructor({ retryMs = 1_000, timeoutMs = 60_000, maxRetries = 5 }: BridgeOptions = {}) {
    this.retryMs = retryMs
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
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
      for (let attempt = 0; ; attempt++) {
        if (this.closed || token.cancelled) return false
        await this.onStart?.(call)
        const { outcome, body } = await this.attempt(call)
        if (token.cancelled) return false
        const stop =
          outcome.status !== 'failed' ? undefined
          : outcome.detail.httpStatus === 501 ? 'delivery.permanent-failure'
          : attempt >= (call.unreachable ? UNEXPECTED_RETRIES : this.maxRetries) ? 'delivery.retry-cap-exhausted'
          : undefined
        if (stop && outcome.status === 'failed' && body !== undefined && !call.effect) outcome.detail.body = (body || '{}').slice(0, 500)
        await this.onAttempt?.(call, outcome)
        if (outcome.status === 'delivered') return true
        if (stop) {
          await this.onAttempt?.(call, { status: 'cancelled', reason: stop })
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

  // Recorded: a non-2xx answer is `delivery.target-rejected` with the status; the
  // answer's body is kept for the attempt that ends the delivery (see deliver).
  private async attempt(call: BridgeCall): Promise<{ outcome: Outcome; body?: string }> {
    if (call.unreachable)
      return { outcome: { status: 'failed', reason: 'delivery.unexpected-error', detail: { reason: 'core.unexpected-error', message: call.unreachable } } }
    try {
      // Rules may set any header but these two, which the ledger owns (about-bridges).
      const auth = (await this.authorize?.(call)) ?? {}
      const res = await fetch(`${call.server}${call.path}`, {
        method: call.method,
        headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
        body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const text = await res.text().catch(() => '')
      if (res.status >= 200 && res.status < 300) return { outcome: { status: 'delivered', detail: { httpStatus: res.status } } }
      return { outcome: { status: 'failed', reason: 'delivery.target-rejected', detail: { httpStatus: res.status } }, body: text }
    } catch (e: any) {
      const code = e?.cause?.code ?? e?.code
      return { outcome: { status: 'failed', reason: 'delivery.target-unreachable', detail: { message: String(e?.cause?.message ?? e?.message ?? e), ...(code ? { code } : {}) } } }
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
