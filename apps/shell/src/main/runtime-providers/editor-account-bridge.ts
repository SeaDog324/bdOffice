import { randomUUID } from 'node:crypto'
import {
  validateToolInput,
  type AgentStreamHandle,
  type IpcToolReply,
  type ToolExecution,
} from '@genoffice/agent-core'
import type {
  AiAccountRoute,
  AiChatRequest,
  AiChatResponse,
  AiIpcEventLike,
  AiStreamChunk,
  AiStreamRequest,
} from '@genoffice/ai-provider'
import type { AgentRuntimeSelection, RuntimeProvider } from '../../shared/runtime-provider-api'
import { createRuntimeProviderTransport } from '../workspace-agent/runtime-provider-transport'
import { accountErrorText } from '../../shared/account-copy'

interface Options {
  selection(): AgentRuntimeSelection
  acquire(): { provider: RuntimeProvider; release(): Promise<void> } | null
  language?(): string
}

interface ActiveStream {
  cancel(): void
  replies: Map<string, (result: ToolExecution) => void>
}

const failure = (output: string): ToolExecution => ({
  output,
  summary: 'Tool not completed',
  isError: true,
})
const streamKey = (event: AiIpcEventLike, id: string) => `${event.sender.id}:${id}`

/** Account-only request/result bridge. No HTTP client, API configuration or token access. */
export class EditorAccountBridge implements AiAccountRoute {
  private readonly active = new Map<string, ActiveStream>()
  constructor(private readonly options: Options) {}

  selection(): AgentRuntimeSelection {
    return this.options.selection()
  }

  async stream(event: AiIpcEventLike, request: AiStreamRequest): Promise<boolean> {
    if (this.selection() === 'api') return false
    await this.run(event, request, (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream-chunk', chunk)
    })
    return true
  }

  cancel(event: AiIpcEventLike, requestId: string): void {
    if (typeof requestId === 'string') this.active.get(streamKey(event, requestId))?.cancel()
  }

  reply(event: AiIpcEventLike, value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const reply = value as IpcToolReply
    if (typeof reply.requestId !== 'string' || typeof reply.toolRequestId !== 'string') return false
    const run = this.active.get(streamKey(event, reply.requestId))
    const pending = run?.replies.get(reply.toolRequestId)
    if (!pending) return false
    const result = reply.result
    run!.replies.delete(reply.toolRequestId)
    if (
      !result ||
      typeof result.output !== 'string' ||
      result.output.length > 2 * 1024 * 1024 ||
      typeof result.summary !== 'string' ||
      result.summary.length > 4096
    ) {
      pending(failure('Invalid tool result; no completion was confirmed.'))
      return false
    }
    pending({
      output: result.output,
      summary: result.summary,
      isError: result.isError === true || result.denied === true,
      denied: result.denied === true,
    })
    return true
  }

  async chat(event: AiIpcEventLike, request: AiChatRequest): Promise<AiChatResponse | null> {
    if (this.selection() === 'api') return null
    let text = ''
    let error: string | undefined
    await this.run(
      event,
      {
        requestId: randomUUID(),
        settings: request.settings,
        system: request.system,
        messages: [{ role: 'user', text: request.user }],
        tools: [],
      },
      (chunk) => {
        if (chunk.type === 'delta') text += chunk.text ?? ''
        else if (chunk.type === 'error') error = chunk.error ?? 'Account request failed.'
        else if (chunk.type === 'done' && chunk.stopReason === 'cancelled')
          error = 'Request cancelled.'
      },
    )
    return error ? { ok: false, error } : { ok: true, content: text }
  }

  private async run(
    event: AiIpcEventLike,
    request: AiStreamRequest,
    send: (chunk: AiStreamChunk) => void,
  ): Promise<void> {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : ''
    if (!requestId || requestId.length > 256 || event.sender.isDestroyed()) return
    if (
      typeof request.system !== 'string' ||
      !Array.isArray(request.messages) ||
      (request.tools !== undefined &&
        (!Array.isArray(request.tools) ||
          request.tools.length > 512 ||
          request.tools.some(
            (tool) => !tool || typeof tool.name !== 'string' || !tool.inputSchema,
          )))
    ) {
      send({ requestId, type: 'error', error: 'Invalid assistant request.' })
      return
    }
    let lease: ReturnType<Options['acquire']>
    try {
      lease = this.options.acquire()
      if (!lease) throw new Error('Account selection changed. Please send your request again.')
    } catch (error) {
      send({ requestId, type: 'error', error: accountErrorText(error, this.options.language?.()) })
      return
    }
    const key = streamKey(event, requestId)
    this.active.get(key)?.cancel()
    const tools = request.tools ?? []
    const definitions = new Map(tools.map((tool) => [tool.name, tool]))
    const transport = createRuntimeProviderTransport({
      getProvider: () => lease.provider,
      fallback: {
        stream() {
          throw new Error('An account request cannot use API configuration.')
        },
      },
    })
    try {
      await new Promise<void>((resolve) => {
        let settled = false
        let handle: AgentStreamHandle | undefined
        let stopReason: string | undefined
        const finish = (error?: string) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          clearInterval(keepalive)
          event.sender.removeListener?.('destroyed', onDestroyed)
          for (const reply of state.replies.values())
            reply(failure('Request ended; tool not completed.'))
          state.replies.clear()
          if (this.active.get(key) === state) this.active.delete(key)
          try {
            send(
              error
                ? {
                    requestId,
                    type: 'error',
                    error: accountErrorText(error, this.options.language?.()),
                  }
                : { requestId, type: 'done', stopReason },
            )
          } finally {
            resolve()
          }
        }
        const state: ActiveStream = {
          replies: new Map(),
          cancel: () => {
            stopReason = 'cancelled'
            finish()
            handle?.cancel()
          },
        }
        const onDestroyed = () => state.cancel()
        const timeout = setTimeout(() => {
          finish('Account request timed out. Please try again.')
          handle?.cancel()
        }, 10 * 60_000)
        timeout.unref?.()
        // While approval or an editor tool is pending the upstream may send no text.
        const keepalive = setInterval(() => send({ requestId, type: 'ping' }), 5_000)
        keepalive.unref?.()
        this.active.set(key, state)
        event.sender.once?.('destroyed', onDestroyed)
        try {
          handle = transport.stream(
            { system: request.system, messages: request.messages, tools },
            {
              onDelta: (text) => {
                if (!settled) send({ requestId, type: 'delta', text })
              },
              onToolCall: () => finish('Unsupported tool response. Please reconnect the account.'),
              onToolRequest: (call) => {
                if (settled) return Promise.resolve(failure('Request stopped; not executed.'))
                const definition = definitions.get(call.name)
                if (!definition) return Promise.resolve(failure('Undeclared tool; not executed.'))
                const invalid = validateToolInput(definition.inputSchema, call.input)
                if (invalid) return Promise.resolve(failure(invalid))
                const toolRequestId = randomUUID()
                return new Promise<ToolExecution>((resolveTool) => {
                  state.replies.set(toolRequestId, resolveTool)
                  send({ requestId, type: 'tool-request', toolRequestId, toolCall: call })
                })
              },
              onStopReason: (reason) => {
                stopReason = reason
              },
              onDone: () => finish(),
              onError: (error) => finish(error),
            },
          )
        } catch (error) {
          finish(error instanceof Error ? error.message : String(error))
        }
      })
    } finally {
      await lease.release()
    }
  }
}
