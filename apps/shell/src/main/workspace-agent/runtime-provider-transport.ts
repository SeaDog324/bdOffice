import type { AgentMessage, AgentStreamRequest, AgentTransport } from '@genoffice/agent-core'
import { composeSystemPrompt } from '@genoffice/ai-provider'
import {
  TEXT_ONLY_RUNTIME_CAPABILITIES,
  type RuntimeProvider,
  type RuntimeProviderCapabilities,
} from '../../shared/runtime-provider-api'

const MAX_RUNTIME_PROMPT_CHARS = 1024 * 1024
const providerRuns = new WeakMap<RuntimeProvider, Promise<void>>()

/** A cancelled UI can finish before the vendor process releases its turn. */
function waitForRuntimeTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(new Error('Runtime request was cancelled.'))
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            'The previous Runtime turn is still stopping or busy. Try again after it finishes.',
          ),
        ),
      10_000,
    )
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else void previous.then(() => finish())
  })
}
const TEXT_ONLY_BOUNDARY = [
  '<runtime-boundary>',
  'This local subscription runtime integration is phase-one text-only.',
  'Do not invoke tools, edit files, run commands, or claim that an Office document was changed.',
  'Answer the latest user request as useful natural-language text. If an actual file change is required, explain that the API runtime must be selected.',
  '</runtime-boundary>',
].join('\n')

function runtimeBoundary(capabilities: RuntimeProviderCapabilities): string {
  if (!capabilities.officeTools) return TEXT_ONLY_BOUNDARY
  return [
    '<runtime-boundary>',
    'Office tool calls must be emitted only through the structured runtime tool-call event.',
    'The registered functions use bigdog_* wire aliases for the Office tool names; invoke those functions, never print a simulated tool call as prose.',
    'Never edit files or run commands directly; BigDog Office applies every call through its Tool Registry, permission, checkpoint, and review pipeline.',
    'Keep user-facing replies concise. Do not narrate internal protocols, runtimes, SDKs, or connection infrastructure.',
    '</runtime-boundary>',
  ].join('\n')
}

function renderMessage(message: AgentMessage): string {
  if (message.role === 'tool') {
    return [
      '[tool results]',
      ...message.results.map(
        (result) =>
          `${result.name} [${result.id}] (${result.isError ? 'error' : 'ok'}):\n${result.output}`,
      ),
    ].join('\n')
  }
  const imageNote =
    message.role === 'user' && message.images?.length
      ? `\n[${message.images.length} image attachment(s) omitted by the text-only runtime]`
      : ''
  const reasoning =
    message.role === 'assistant' && message.reasoning ? `\n[prior reasoning omitted]` : ''
  const calls =
    message.role === 'assistant' && message.toolCalls?.length
      ? `\n[prior tool calls]\n${JSON.stringify(message.toolCalls)}`
      : ''
  return `[${message.role}]\n${message.text}${imageNote}${reasoning}${calls}`
}

/** Flatten the existing AgentLoop context for a vendor-owned text runtime. */
export function serializeRuntimePrompt(
  request: AgentStreamRequest,
  capabilities: RuntimeProviderCapabilities = TEXT_ONLY_RUNTIME_CAPABILITIES,
): string {
  const tools = capabilities.officeTools
    ? ['<office-tools>', JSON.stringify(request.tools.map((tool) => tool.name)), '</office-tools>']
    : []
  const prefix = [
    '<system>',
    composeSystemPrompt(request.system),
    '</system>',
    '<conversation>',
  ].join('\n\n')
  const suffix = ['</conversation>', ...tools, runtimeBoundary(capabilities)].join('\n\n')
  const rendered = request.messages.map(renderMessage)
  const full = [prefix, ...rendered, suffix].join('\n\n')
  if (full.length <= MAX_RUNTIME_PROMPT_CHARS) return full
  // AgentLoop owns compaction and the active-run boundary. A role=user entry
  // here may be a synthetic summary/verification/finalizing instruction, so
  // trimming at it could erase the actual user goal or matching tool results.
  throw new Error(
    'Runtime context exceeds the local safety limit. Narrow the document selection or start a new conversation; system instructions and the latest turn were not truncated.',
  )
}

interface RuntimeProviderTransportOptions {
  fallback: AgentTransport
  getProvider(): RuntimeProvider | null
  formatError?(error: string): string
}

/** Selects the local runtime at turn time; `api` continues through fallback. */
export function createRuntimeProviderTransport(
  options: RuntimeProviderTransportOptions,
): AgentTransport {
  return {
    stream(request, callbacks) {
      const provider = options.getProvider()
      if (!provider) return options.fallback.stream(request, callbacks)
      if (
        !provider.capabilities.imageInput &&
        request.messages.some((message) => message.role === 'user' && message.images?.length)
      ) {
        let settled = false
        queueMicrotask(() => {
          if (settled) return
          settled = true
          const error =
            'This account connection does not support image input yet. Remove the images and try again.'
          callbacks.onError(options.formatError?.(error) ?? error)
        })
        return {
          cancel() {
            if (!settled) {
              settled = true
              callbacks.onDone()
            }
          },
        }
      }
      const previous = providerRuns.get(provider)
      let release!: () => void
      const finished = new Promise<void>((resolve) => {
        release = resolve
      })
      // Even a queued request cancelled before starting cannot release an
      // earlier request's lease and let a third request bypass cleanup.
      const lease = previous ? previous.then(() => finished) : finished
      providerRuns.set(provider, lease)
      void lease.then(() => {
        if (providerRuns.get(provider) === lease) providerRuns.delete(provider)
      })
      const waiting = new AbortController()
      const declaredTools = new Set(request.tools.map((tool) => tool.name))
      let settled = false
      let cancelled = false
      let started = false
      let cancelTimer: ReturnType<typeof setTimeout> | undefined
      const done = (reason?: string) => {
        if (settled) return
        settled = true
        if (cancelTimer !== undefined) clearTimeout(cancelTimer)
        if (reason) callbacks.onStopReason?.(reason)
        callbacks.onDone()
      }
      const fail = (error: string) => {
        if (settled) return
        settled = true
        if (cancelTimer !== undefined) clearTimeout(cancelTimer)
        if (cancelled) callbacks.onDone()
        else callbacks.onError(options.formatError?.(error) ?? error)
      }
      const stopProvider = () => {
        try {
          void provider.cancel().catch(() => {})
        } catch {
          // Preserve the original protocol error if cancellation also fails.
        }
      }
      queueMicrotask(() => {
        void (async () => {
          try {
            if (previous) await waitForRuntimeTurn(previous, waiting.signal)
            if (cancelled) {
              done('cancelled')
              return
            }
            const prompt = serializeRuntimePrompt(request, provider.capabilities)
            started = true
            for await (const event of provider.generate(
              prompt,
              provider.capabilities.officeTools
                ? {
                    tools: request.tools,
                    executeTool: async (call) => {
                      if (settled || cancelled)
                        return {
                          output: 'Run stopped; not executed.',
                          isError: true,
                          summary: call.name,
                        }
                      if (!declaredTools.has(call.name))
                        throw new Error(`Undeclared Office tool: ${call.name}`)
                      if (!callbacks.onToolRequest)
                        throw new Error(
                          'This Agent host does not support structured Runtime tool results.',
                        )
                      return callbacks.onToolRequest(call)
                    },
                  }
                : undefined,
            )) {
              if (settled) {
                // UI completion is not proof that the vendor released its
                // generation lock. Drain late deltas until a real terminal.
                if (event.type === 'done' || event.type === 'error') break
                continue
              }
              if (cancelled) {
                if (event.type === 'done' || event.type === 'error') {
                  done('cancelled')
                  break
                }
                continue
              }
              if (event.type === 'text-delta') callbacks.onDelta(event.text)
              else if (event.type === 'tool-call') {
                if (!provider.capabilities.officeTools) {
                  fail(
                    'The selected Runtime emitted an Office tool call without declaring tool capability.',
                  )
                  stopProvider()
                  continue
                }
                if (!declaredTools.has(event.name)) {
                  fail(`The selected Runtime requested an undeclared Office tool: ${event.name}.`)
                  stopProvider()
                  continue
                }
                callbacks.onToolCall({ id: event.id, name: event.name, input: event.input })
              } else if (event.type === 'status') {
                callbacks.onPhase?.({
                  kind: event.status === 'streaming' ? 'responding' : 'requesting',
                })
              } else if (event.type === 'done') {
                done(event.stopReason)
                break
              } else if (event.type === 'error') {
                fail(event.error)
                break
              }
            }
            done(cancelled ? 'cancelled' : undefined)
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error))
          } finally {
            release()
          }
        })()
      })
      return {
        cancel() {
          if (settled || cancelled) return
          cancelled = true
          waiting.abort()
          if (!started) {
            done('cancelled')
            return
          }
          // The runtime normally emits its terminal event after interrupting.
          // A broken implementation must not hold the Agent loop indefinitely.
          cancelTimer = setTimeout(() => done('cancelled'), 3_000)
          cancelTimer.unref?.()
          try {
            void provider.cancel().catch(() => done('cancelled'))
          } catch {
            done('cancelled')
          }
        },
      }
    },
  }
}
