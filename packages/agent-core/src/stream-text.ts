import type { AgentStreamHandle, AgentTransport } from './types'

/** Tool-less artifact streaming. The host owns approval before adopting the result. */
export interface StreamTextOptions {
  transport: AgentTransport
  system: string
  user: string
  signal?: AbortSignal
  maxChars: number
  /** Absolute request budget; even a transport that never calls back is cancelled. */
  timeoutMs?: number
  /** Batch cumulative extraction/progress to avoid reparsing a growing artifact per token. */
  progressIntervalMs?: number
  extract(raw: string): { text: string; complete?: boolean }
  onProgress?(text: string): void
}

export type StreamTextOutcome =
  | { status: 'complete'; text: string }
  | { status: 'partial'; text: string; reason: 'error' | 'stopped' | 'max_tokens'; error?: string }
  | { status: 'empty'; error: string }

/** Resolves once, never throws; handles synchronous as well as asynchronous transports. */
export function streamText(opts: StreamTextOptions): Promise<StreamTextOutcome> {
  return new Promise((resolve) => {
    let raw = ''
    let stopReason: string | undefined
    let settled = false
    let handle: AgentStreamHandle | undefined
    let cancelPending = false
    let timer: ReturnType<typeof setTimeout> | undefined = undefined
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    const maxChars = Math.floor(opts.maxChars)
    const cancel = () => {
      cancelPending = true
      try {
        handle?.cancel()
      } catch {
        /* settlement still owns cleanup */
      }
    }
    const finish = (outcome: StreamTextOutcome, abortTransport = false) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (progressTimer) clearTimeout(progressTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      // Settle before cancel: cancel may synchronously report onDone.
      if (abortTransport) cancel()
      resolve(outcome)
    }
    const partialOrEmpty = (
      reason: 'error' | 'stopped' | 'max_tokens',
      error?: string,
    ): StreamTextOutcome => {
      try {
        const { text } = opts.extract(raw)
        if (!text.trim()) return { status: 'empty', error: error ?? reason }
        return error === undefined
          ? { status: 'partial', text, reason }
          : { status: 'partial', text, reason, error }
      } catch (err) {
        return { status: 'empty', error: err instanceof Error ? err.message : String(err) }
      }
    }
    const fail = (err: unknown) =>
      finish(partialOrEmpty('error', err instanceof Error ? err.message : String(err)), true)
    const progress = () => {
      progressTimer = undefined
      if (settled) return
      try {
        opts.onProgress?.(opts.extract(raw).text)
      } catch (err) {
        fail(err)
      }
    }
    const onAbort = () => finish(partialOrEmpty('stopped'), true)
    if (!Number.isFinite(maxChars) || maxChars <= 0) {
      finish({ status: 'empty', error: 'maxChars must be a positive finite number' })
      return
    }
    if (opts.signal?.aborted) {
      onAbort()
      return
    }
    const timeout = opts.timeoutMs ?? 180_000
    if (!Number.isFinite(timeout) || timeout <= 0) {
      finish({ status: 'empty', error: 'timeoutMs must be a positive finite number' })
      return
    }
    timer = setTimeout(() => fail(`text generation timed out after ${timeout}ms`), timeout)
    try {
      handle = opts.transport.stream(
        { system: opts.system, messages: [{ role: 'user', text: opts.user }], tools: [] },
        {
          onDelta: (delta) => {
            if (settled) return
            const overflow = raw.length + delta.length > maxChars
            raw += delta.slice(0, maxChars - raw.length)
            if (overflow) {
              finish(partialOrEmpty('max_tokens', `output exceeded ${maxChars} chars`), true)
              return
            }
            const interval = opts.progressIntervalMs ?? 32
            if (interval <= 0) progress()
            else if (!progressTimer) progressTimer = setTimeout(progress, interval)
          },
          onToolCall: () => fail('artifact generation returned an unexpected tool call'),
          onStopReason: (reason) => {
            if (!settled) stopReason = reason
          },
          onDone: () => {
            if (settled) return
            try {
              const { text, complete } = opts.extract(raw)
              opts.onProgress?.(text)
              if (settled) return
              const finished = complete ?? (stopReason !== 'max_tokens' && text.trim() !== '')
              if (finished && text.trim()) finish({ status: 'complete', text })
              else if (stopReason === 'max_tokens') finish(partialOrEmpty('max_tokens'))
              else
                finish(partialOrEmpty('error', complete === undefined ? 'empty reply' : undefined))
            } catch (err) {
              fail(err)
            }
          },
          onError: fail,
        },
      )
      if (cancelPending) {
        try {
          handle.cancel()
        } catch {
          /* already settled */
        }
      }
      if (!settled) {
        if (opts.signal?.aborted) onAbort()
        else opts.signal?.addEventListener('abort', onAbort, { once: true })
      }
    } catch (err) {
      fail(err)
    }
  })
}
