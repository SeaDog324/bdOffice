import type {
  AgentStreamRequest,
  AgentTokenUsage,
  AgentToolCall,
  AgentToolDef,
  AgentTransport,
  AgentMessage,
  ToolExecution,
} from './types'

/**
 * One streamed chunk pushed back over an Electron IPC bridge. Structurally
 * identical to ai-provider's AiStreamChunk; declared here so this package
 * stays dependency-free.
 */
export interface IpcStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive; re-arms the silence watchdog and carries no payload;
   * 'reasoning' = model thinking delta (text carries it) */
  type: 'delta' | 'reasoning' | 'tool-call' | 'tool-request' | 'usage' | 'done' | 'error' | 'ping'
  text?: string
  toolCall?: AgentToolCall
  /** Opaque reply capability, scoped to this sender and streaming request. */
  toolRequestId?: string
  error?: string
  /** machine-readable error cause; maps to the localized timeout/credits/network/overloaded/region message */
  errorCode?: 'timeout' | 'credits' | 'network' | 'overloaded' | 'region'
  /** normalized stop reason on 'done' ('max_tokens' = cut off by the token limit) */
  stopReason?: string
  /** tokens the provider billed for this turn, carried on 'usage' (always sent before 'done') */
  usage?: AgentTokenUsage
}

export interface IpcToolReply {
  requestId: string
  toolRequestId: string
  result: Pick<ToolExecution, 'output' | 'summary' | 'isError' | 'denied'>
}

/** The request forwarded to the main process to start one streaming turn. */
export interface IpcStreamStart<S> {
  requestId: string
  /** Stable for the lifetime of one renderer-side transport. Providers with
   * native conversations can reuse it across the tool loop and follow-ups. */
  sessionId: string
  settings: S
  system: string
  messages: AgentMessage[]
  tools: AgentToolDef[]
}

/**
 * Renderer-side silence watchdog: the main process re-arms it with keepalive
 * pings on wire activity, so firing means the turn is dead (main-process stall,
 * lost chunks) and the run must fail instead of leaving the UI busy forever.
 * Longer than the main-process idle timeout (180s) so that one (localized) wins.
 */
export const IPC_STREAM_SILENCE_TIMEOUT_MS = 240_000

export interface IpcTransportOptions<S> {
  approveTool?: AgentTransport['approveTool']
  /** subscribe to stream chunks; returns the unsubscribe function */
  onStream(listener: (chunk: IpcStreamChunk) => void): () => void
  /** forward the start request to the main process; a returned promise reports handler failure */
  start(request: IpcStreamStart<S>): void | Promise<unknown>
  /** abort the in-flight turn in the main process */
  cancel(requestId: string): void
  /** Return the actual approved execution result to an account-owned turn. */
  respondTool?(reply: IpcToolReply): void | Promise<unknown>
  getSettings(): S
  /** localized fallback when an error chunk carries no message */
  unknownErrorText(): string
  /** localized message for timeouts (errorCode 'timeout' and the silence watchdog) */
  timeoutErrorText?(): string
  /** localized message for exhausted credits (errorCode 'credits') */
  creditsErrorText?(): string
  /** localized message for network connectivity failures (errorCode 'network') */
  networkErrorText?(): string
  /** localized message for capacity/rate-limit failures (errorCode 'overloaded') */
  overloadedErrorText?(): string
  /** localized message when the vendor refuses the request origin (errorCode 'region') */
  regionErrorText?(): string
}

/**
 * AgentTransport over an Electron IPC bridge: the main process talks to the
 * LLM providers (avoids renderer CORS) and streams chunks back per requestId.
 * Each app wires in its own preload bridge and i18n via the options.
 */
export function createIpcTransport<S>(options: IpcTransportOptions<S>): AgentTransport {
  const timeoutText = () => options.timeoutErrorText?.() ?? options.unknownErrorText()
  const sessionId = crypto.randomUUID()
  return {
    ...(options.approveTool ? { approveTool: options.approveTool } : {}),
    stream(request: AgentStreamRequest, cb) {
      const requestId = crypto.randomUUID()
      let settled = false
      const toolReplies = new Map<string, { signature: string; result: Promise<void> }>()
      let silenceTimer: ReturnType<typeof setTimeout> | undefined
      const settle = () => {
        settled = true
        clearTimeout(silenceTimer)
        unsubscribe()
      }
      const fail = (error: string) => {
        if (settled) return
        settle()
        cb.onError(error)
      }
      const stopWithError = (error: string) => {
        // Settle locally first: an immediate cancel acknowledgement is not success.
        fail(error)
        try {
          options.cancel(requestId)
        } catch {
          /* Already settled locally. */
        }
      }
      const armSilence = () => {
        clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => {
          try {
            options.cancel(requestId)
          } catch {
            // The local watchdog must settle even if the bridge is unavailable.
          }
          fail(timeoutText())
        }, IPC_STREAM_SILENCE_TIMEOUT_MS)
      }
      const unsubscribe = options.onStream((chunk) => {
        if (chunk.requestId !== requestId || settled) return
        if (chunk.type === 'ping') {
          armSilence()
        } else if (chunk.type === 'delta') {
          armSilence()
          cb.onDelta(chunk.text ?? '')
        } else if (chunk.type === 'reasoning') {
          armSilence()
          if (chunk.text) cb.onReasoning?.(chunk.text)
        } else if (chunk.type === 'tool-call') {
          armSilence()
          if (chunk.toolCall) cb.onToolCall(chunk.toolCall)
        } else if (chunk.type === 'tool-request') {
          armSilence()
          const call = chunk.toolCall
          const toolRequestId = chunk.toolRequestId
          if (!call || !toolRequestId || !options.respondTool || !cb.onToolRequest) {
            stopWithError(
              'This assistant cannot handle account tool calls. Reopen the document and try again.',
            )
            return
          }
          const signature = JSON.stringify(call)
          const previous = toolReplies.get(toolRequestId)
          if (previous) {
            if (previous.signature !== signature) {
              stopWithError('Invalid tool request.')
            }
            return
          }
          const result = Promise.resolve()
            .then(async () => {
              if (settled) return
              const execution = await cb.onToolRequest!(call).catch(
                (error: unknown): ToolExecution => ({
                  output: error instanceof Error ? error.message : String(error),
                  summary: call.name,
                  isError: true,
                }),
              )
              if (settled) return
              await options.respondTool!({
                requestId,
                toolRequestId,
                // Display metadata and document snapshots never cross this bridge.
                result: {
                  output: execution.output,
                  summary: execution.summary,
                  isError: execution.isError === true || execution.denied === true,
                  denied: execution.denied === true,
                },
              })
            })
            .catch((error: unknown) => {
              if (settled) return
              stopWithError(error instanceof Error ? error.message : options.unknownErrorText())
            })
          toolReplies.set(toolRequestId, { signature, result })
        } else if (chunk.type === 'usage') {
          armSilence()
          if (chunk.usage) cb.onUsage?.(chunk.usage)
        } else if (chunk.type === 'done') {
          settle()
          if (chunk.stopReason) cb.onStopReason?.(chunk.stopReason)
          cb.onDone()
        } else if (chunk.type === 'error') {
          settle()
          cb.onError(
            chunk.errorCode === 'timeout'
              ? timeoutText()
              : chunk.errorCode === 'credits'
                ? (options.creditsErrorText?.() ?? chunk.error ?? options.unknownErrorText())
                : chunk.errorCode === 'network'
                  ? (options.networkErrorText?.() ?? chunk.error ?? options.unknownErrorText())
                  : chunk.errorCode === 'overloaded'
                    ? (options.overloadedErrorText?.() ?? chunk.error ?? options.unknownErrorText())
                    : chunk.errorCode === 'region'
                      ? (options.regionErrorText?.() ?? chunk.error ?? options.unknownErrorText())
                      : (chunk.error ?? options.unknownErrorText()),
          )
        } else {
          // A chunk kind this build predates must not kill the run; traffic proves it is alive.
          armSilence()
        }
      })
      armSilence()
      try {
        // a rejected/thrown start would otherwise leave the run pending until the watchdog
        Promise.resolve(
          options.start({
            requestId,
            sessionId,
            settings: options.getSettings(),
            system: request.system,
            messages: request.messages,
            tools: request.tools,
          }),
        ).catch((err: unknown) => {
          fail(err instanceof Error ? err.message : options.unknownErrorText())
        })
      } catch (err) {
        fail(err instanceof Error ? err.message : options.unknownErrorText())
      }
      return {
        cancel: () => {
          if (settled) return
          // Do not wait for a main-process acknowledgement: a lost `done`
          // would otherwise leave a stopped UI busy until the silence timeout.
          settle()
          try {
            options.cancel(requestId)
          } catch {
            // Cancellation is still final locally when the main process is gone.
          }
          cb.onDone()
        },
      }
    },
  }
}
