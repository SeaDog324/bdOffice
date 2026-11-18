import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { aiFetch } from '../fetch'
import { httpBodyDetail } from '../http-error'
import { composeSystemPrompt, opencodeSessionHeaders } from '../providers'
import { providerToolNames, type ProviderToolNameMap } from '../tool-names'
import type { AiChatResponse, AiProviderConfig } from '../types'
import { createStreamWatchdog, type StreamWatchdog } from '../watchdog'
import { createUsageReporter } from './usage'
import {
  jsonBodyInsteadOfSse,
  parseToolInput,
  sseErrorText,
  sseLines,
  throwIfCreditsNotice,
  throwIfToolCountOverBudget,
  throwIfToolJsonOverBudget,
  type StreamCallbacks,
} from './shared'

const SIGNATURE_PREFIX = 'openai-responses:v1:'
const MAX_CONTINUATION_CHARS = 1024 * 1024
interface ReasoningItem {
  type: 'reasoning'
  id: string
  encrypted_content: string
  summary: []
}
interface Continuation {
  scope: string
  itemId?: string
  reasoning?: ReasoningItem[]
}
interface OutputItem {
  type?: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  encrypted_content?: string
  content?: Array<{ type?: string; text?: string; refusal?: string }>
  status?: string
}
interface ResponseBody {
  status?: string
  output?: OutputItem[]
  error?: unknown
  incomplete_details?: { reason?: string }
}

export function responsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.pathname =
    url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses)$/, '') +
    '/responses'
  return url.toString()
}

async function continuationScope(baseUrl: string, config: AiProviderConfig): Promise<string> {
  // Scope opaque reasoning to the same endpoint, model and credential without saving the key.
  const bytes = new TextEncoder().encode(
    `${responsesUrl(baseUrl)}\0${config.model}\0${config.apiKey}`,
  )
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}
function reasoningItem(item: OutputItem): ReasoningItem | undefined {
  if (item.type !== 'reasoning' || typeof item.encrypted_content !== 'string') return undefined
  if (typeof item.id !== 'string' || !item.id || item.id.length > 256)
    throw new Error('Responses returned an invalid reasoning item identity.')
  if (item.encrypted_content.length > MAX_CONTINUATION_CHARS)
    throw new Error('Responses reasoning continuation exceeded the bounded context limit.')
  return { type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: [] }
}
function continuation(signature: string | undefined, scope: string): Continuation | undefined {
  if (
    typeof signature !== 'string' ||
    !signature.startsWith(SIGNATURE_PREFIX) ||
    signature.length > MAX_CONTINUATION_CHARS
  )
    return undefined
  try {
    const value = JSON.parse(signature.slice(SIGNATURE_PREFIX.length)) as Continuation
    if (
      value.scope !== scope ||
      (value.itemId !== undefined &&
        (typeof value.itemId !== 'string' || value.itemId.length > 256))
    )
      return undefined
    const reasoning = Array.isArray(value.reasoning)
      ? value.reasoning.slice(0, 100).flatMap((item) => {
          const normalized = reasoningItem(item)
          return normalized ? [normalized] : []
        })
      : []
    return { scope, ...(value.itemId ? { itemId: value.itemId } : {}), reasoning }
  } catch {
    return undefined
  }
}

function responseInput(
  messages: AgentMessage[],
  names: ProviderToolNameMap,
  scope: string,
): unknown[] {
  const input: unknown[] = []
  const seenReasoning = new Set<string>()
  for (const message of messages) {
    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: message.images?.length
          ? [
              ...(message.text ? [{ type: 'input_text', text: message.text }] : []),
              ...message.images.map((image) => ({
                type: 'input_image',
                image_url: `data:${image.mime};base64,${image.base64}`,
              })),
            ]
          : message.text,
      })
    } else if (message.role === 'assistant') {
      const calls = message.toolCalls ?? []
      const metadata = calls.map((call) => continuation(call.signature, scope))
      for (const meta of metadata)
        for (const item of meta?.reasoning ?? []) {
          if (!seenReasoning.has(item.id)) {
            input.push(item)
            seenReasoning.add(item.id)
          }
        }
      if (message.text) input.push({ role: 'assistant', content: message.text })
      calls.forEach((call, index) =>
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: names.toWire(call.name),
          arguments: JSON.stringify(call.input),
          ...(metadata[index]?.itemId ? { id: metadata[index]!.itemId } : {}),
        }),
      )
    } else
      for (const result of message.results)
        input.push({
          type: 'function_call_output',
          call_id: result.id,
          output: result.images?.length
            ? [
                { type: 'input_text', text: result.output },
                ...result.images.map((image) => ({
                  type: 'input_image',
                  image_url: `data:${image.mime};base64,${image.base64}`,
                })),
              ]
            : result.output,
        })
  }
  return input
}

function requestHeaders(baseUrl: string, config: AiProviderConfig, sessionId?: string) {
  return {
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...opencodeSessionHeaders(baseUrl, sessionId),
  }
}
async function requestFailure(response: Response): Promise<never> {
  const detail = httpBodyDetail(await response.text())
  const hint =
    response.status === 404 || response.status === 405
      ? ' 当前模型的工具调用需要 Responses API，请确认当前服务支持 /v1/responses。'
      : ''
  throw new Error(`HTTP ${response.status}: ${detail}${hint}`)
}
function visibleText(body: ResponseBody): string {
  return (Array.isArray(body.output) ? body.output : [])
    .flatMap((item) =>
      item.type === 'message' && Array.isArray(item.content)
        ? item.content.map((part) =>
            part.type === 'output_text'
              ? part.text || ''
              : part.type === 'refusal'
                ? part.refusal || ''
                : '',
          )
        : [],
    )
    .join('')
}
function checkStatus(body: ResponseBody): boolean {
  if (body.error) throw new Error(sseErrorText(body.error, 'Responses API error'))
  if (body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens')
    return true
  if (body.status !== 'completed')
    throw new Error(`Responses API did not complete (${body.status || 'missing status'}).`)
  return false
}

/** Stateless Responses turns preserve only encrypted reasoning in the existing opaque tool signature. */
export async function streamOpenAiResponses(
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  const wd = createStreamWatchdog(cb.signal)
  return wd.guard(async () => {
    const names = providerToolNames(messages, tools)
    const scope = await continuationScope(baseUrl, config)
    wd.signal.throwIfAborted()
    const response = await aiFetch(responsesUrl(baseUrl), {
      method: 'POST',
      signal: wd.signal,
      headers: requestHeaders(baseUrl, config, cb.sessionId),
      body: JSON.stringify({
        model: config.model,
        instructions: composeSystemPrompt(system),
        input: responseInput(messages, names, scope),
        max_output_tokens: maxTokens,
        store: false,
        include: ['reasoning.encrypted_content'],
        // Optional fields in existing office schemas must remain optional.
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: 'function',
                name: names.toWire(tool.name),
                description: tool.description,
                parameters: tool.inputSchema,
                strict: false,
              })),
            }
          : {}),
        stream: true,
      }),
    })
    const activity = () => {
      wd.touch()
      cb.onActivity?.()
    }
    activity()
    if (!response.ok) return requestFailure(response)
    if (!response.body) throw new Error('Responses API returned no response body.')
    const usage = createUsageReporter('openai-responses', cb.onUsage)
    const pending = new Map<number, OutputItem>()
    const reasoning = new Map<string, ReasoningItem>()
    let continuationChars = 0,
      emittedText = false,
      terminal: ResponseBody | undefined
    function observeItem(index: number, item: OutputItem) {
      if (!Number.isSafeInteger(index) || index < 0 || index > 1000)
        throw new Error('Responses returned an invalid output index.')
      if (item.type === 'function_call') {
        if (!pending.has(index)) throwIfToolCountOverBudget(pending.size + 1, 'openai-responses')
        if (typeof item.arguments === 'string')
          throwIfToolJsonOverBudget(item.arguments.length, 'openai-responses')
        pending.set(index, { ...pending.get(index), ...item })
      }
      const normalized = reasoningItem(item)
      if (normalized) {
        continuationChars +=
          normalized.encrypted_content.length -
          (reasoning.get(normalized.id)?.encrypted_content.length || 0)
        if (continuationChars > MAX_CONTINUATION_CHARS / 2)
          throw new Error('Responses reasoning continuation exceeded the bounded context limit.')
        reasoning.set(normalized.id, normalized)
      }
    }
    const json = await jsonBodyInsteadOfSse(response)
    if (json !== null) {
      throwIfCreditsNotice(json)
      terminal = JSON.parse(json) as ResponseBody
      usage.observe(terminal)
    } else {
      for await (const line of sseLines(response.body, activity)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let event: {
          type?: string
          output_index?: number
          delta?: string
          arguments?: string
          item?: OutputItem
          response?: ResponseBody
          error?: unknown
          message?: string
        }
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        if (!event || typeof event !== 'object') continue
        if (event.type === 'error' || event.type === 'response.failed')
          throw new Error(
            sseErrorText(
              event.error || event.response?.error || event.message,
              'Responses API stream failed.',
            ),
          )
        if (
          (event.type === 'response.output_text.delta' ||
            event.type === 'response.refusal.delta') &&
          typeof event.delta === 'string'
        ) {
          emittedText = true
          cb.onDelta(event.delta)
        } else if (
          event.type === 'response.reasoning_summary_text.delta' &&
          typeof event.delta === 'string'
        )
          cb.onReasoningDelta?.(event.delta)
        else if (
          (event.type === 'response.output_item.added' ||
            event.type === 'response.output_item.done') &&
          event.item
        )
          observeItem(event.output_index!, event.item)
        else if (
          event.type === 'response.function_call_arguments.delta' ||
          event.type === 'response.function_call_arguments.done'
        ) {
          const index = event.output_index!
          const item = pending.get(index) || { type: 'function_call' }
          const args = event.type.endsWith('.done')
            ? event.arguments
            : (item.arguments || '') + (event.delta || '')
          observeItem(index, { ...item, ...(typeof args === 'string' ? { arguments: args } : {}) })
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          terminal = event.response
          usage.observe(event)
          break
        }
      }
    }
    wd.signal.throwIfAborted()
    if (!terminal)
      throw new Error(
        'Responses API stream ended before a completion receipt; no tools were dispatched.',
      )
    const truncated = checkStatus(terminal)
    if (Array.isArray(terminal.output))
      terminal.output.forEach((item, index) => observeItem(index, item))
    if (!emittedText) {
      const text = visibleText(terminal)
      if (text) {
        cb.onDelta(text)
        emittedText = true
      }
    }
    const calls = [...pending.entries()].sort(([left], [right]) => left - right)
    // Dispatch only after the response is terminal. An item-done event alone
    // must not execute writes if the stream subsequently fails or disconnects.
    const completeCalls: AgentToolCall[] = calls.map(([, item], index) => {
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        typeof item.name !== 'string' ||
        !item.name
      )
        throw new Error('Responses returned a function call without a stable call identity.')
      const { input, error } = parseToolInput(item.arguments || '')
      const token: Continuation = {
        scope,
        ...(item.id ? { itemId: item.id } : {}),
        ...(index === 0 && reasoning.size ? { reasoning: [...reasoning.values()] } : {}),
      }
      return {
        id: item.call_id,
        name: names.fromWire(item.name),
        input,
        ...(error ? { inputError: error } : {}),
        ...(truncated && index === calls.length - 1 ? { truncated: true } : {}),
        signature: SIGNATURE_PREFIX + JSON.stringify(token),
      }
    })
    if (!emittedText && !completeCalls.length && !truncated)
      throw new Error('Responses API returned no visible content or function calls.')
    if (truncated) cb.onStopReason?.('max_tokens')
    for (const call of completeCalls) {
      wd.signal.throwIfAborted()
      cb.onToolCall(call)
    }
    usage.finish()
  })
}

export async function chatOpenAiResponses(
  wd: StreamWatchdog,
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  user: string,
): Promise<AiChatResponse> {
  const response = await aiFetch(responsesUrl(baseUrl), {
    method: 'POST',
    signal: wd.signal,
    headers: requestHeaders(baseUrl, config),
    body: JSON.stringify({
      model: config.model,
      instructions: composeSystemPrompt(system),
      input: user,
      store: false,
    }),
  })
  wd.touch()
  if (!response.ok) {
    try {
      await requestFailure(response)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const raw = await response.text()
  let body: ResponseBody
  try {
    body = JSON.parse(raw) as ResponseBody
    checkStatus(body)
  } catch (error) {
    return {
      ok: false,
      error: `Responses API answer failed: ${error instanceof SyntaxError ? httpBodyDetail(raw) : error instanceof Error ? error.message : String(error)}`,
    }
  }
  const content = visibleText(body)
  return content
    ? { ok: true, content }
    : { ok: false, error: 'Responses API returned no visible answer.' }
}
