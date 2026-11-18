/**
 * Abort-linked watchdog for LLM requests: a connect timeout until the response
 * headers arrive, then an idle timeout re-armed on every received byte, plus an
 * absolute deadline that activity cannot extend. A silently stalled connection
 * (dropped by a proxy/VPN/firewall without an RST) otherwise leaves the request
 * pending forever and the UI stuck busy; a chatty reasoning loop must not keep
 * one model round-trip alive forever either.
 */

export const AI_CONNECT_TIMEOUT_MS = 60_000
/**
 * Generous on purpose: on long-context requests the gateway can legitimately go
 * silent for minutes (thinking/buffering before the first token and between
 * chunks). 60s here killed real in-progress generations that were still billed,
 * so only genuinely dead connections should trip this.
 */
export const AI_IDLE_TIMEOUT_MS = 180_000
/** Non-streaming chat waits for the full generation before headers arrive */
export const AI_CHAT_RESPONSE_TIMEOUT_MS = 180_000
/** Absolute cap for one provider request, regardless of keepalives or streamed bytes. */
export const AI_ABSOLUTE_TIMEOUT_MS = 5 * 60_000

export type AiTimeoutKind = 'connect' | 'idle' | 'absolute'
/**
 * Floor for watchdog timeouts. Values in (0, floor) are raised to the floor so
 * a tiny misconfigured timeout cannot instant-abort a healthy request.
 */
export const AI_WATCHDOG_MIN_TIMEOUT_MS = 1_000
/**
 * Cap for watchdog timeouts. Infinite or huge values are lowered to the cap so
 * the watchdog still fires instead of going dead. Kept well below the
 * platform setTimeout overflow limit (2^31-1 ms).
 */
export const AI_WATCHDOG_MAX_TIMEOUT_MS = 600_000

/**
 * Normalize a watchdog timeout to a sane finite positive value.
 * Non-numbers, NaN, and values <= 0 fall back to the caller default;
 * Infinity and values above the cap are lowered to the cap;
 * small positives below the floor are raised to the floor.
 */
export function normalizeWatchdogTimeout(ms: number, fallbackMs: number): number {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms <= 0) return fallbackMs
  if (!Number.isFinite(ms) || ms > AI_WATCHDOG_MAX_TIMEOUT_MS) return AI_WATCHDOG_MAX_TIMEOUT_MS
  if (ms < AI_WATCHDOG_MIN_TIMEOUT_MS) return AI_WATCHDOG_MIN_TIMEOUT_MS
  return ms
}

export class AiTimeoutError extends Error {
  readonly kind: AiTimeoutKind

  constructor(ms: number, kind: AiTimeoutKind = 'idle') {
    super(
      kind === 'absolute'
        ? `AI request exceeded its absolute time limit of ${Math.round(ms / 1000)}s`
        : `AI request timed out: no data received from the network for ${Math.round(ms / 1000)}s`,
    )
    this.name = 'AiTimeoutError'
    this.kind = kind
  }
}

export interface StreamWatchdog {
  /** pass to fetch: aborts on caller cancel or on timeout */
  signal: AbortSignal
  /** data arrived: switch to (and re-arm) the idle timeout */
  touch(): void
  /** run the request; a timeout abort surfaces as AiTimeoutError; always disposes the timer */
  guard<T>(run: () => Promise<T>): Promise<T>
}

export function createStreamWatchdog(
  parent?: AbortSignal,
  connectMs = AI_CONNECT_TIMEOUT_MS,
  idleMs = AI_IDLE_TIMEOUT_MS,
  absoluteMs = AI_ABSOLUTE_TIMEOUT_MS,
): StreamWatchdog {
  const normalizedConnectMs = normalizeWatchdogTimeout(connectMs, AI_CONNECT_TIMEOUT_MS)
  const normalizedIdleMs = normalizeWatchdogTimeout(idleMs, AI_IDLE_TIMEOUT_MS)
  const controller = new AbortController()
  let timeout: { ms: number; kind: AiTimeoutKind } | null = null
  let activityTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const abortForTimeout = (ms: number, kind: AiTimeoutKind) => {
    if (controller.signal.aborted) return
    timeout = { ms, kind }
    controller.abort()
  }
  const armActivity = (ms: number, kind: Exclude<AiTimeoutKind, 'absolute'>) => {
    clearTimeout(activityTimer)
    activityTimer = setTimeout(() => {
      abortForTimeout(ms, kind)
    }, ms)
  }
  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }
  if (parent?.aborted) controller.abort()
  else parent?.addEventListener('abort', onParentAbort, { once: true })
  const normalizedAbsoluteMs = normalizeWatchdogTimeout(absoluteMs, AI_ABSOLUTE_TIMEOUT_MS)
  armActivity(normalizedConnectMs, 'connect')
  const absoluteTimer = setTimeout(
    () => abortForTimeout(normalizedAbsoluteMs, 'absolute'),
    normalizedAbsoluteMs,
  )
  return {
    signal: controller.signal,
    touch: () => {
      if (!disposed && !controller.signal.aborted) armActivity(normalizedIdleMs, 'idle')
    },
    async guard<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await run()
      } catch (e) {
        if (timeout) throw new AiTimeoutError(timeout.ms, timeout.kind)
        throw e
      } finally {
        disposed = true
        clearTimeout(activityTimer)
        clearTimeout(absoluteTimer)
        parent?.removeEventListener('abort', onParentAbort)
      }
    },
  }
}
