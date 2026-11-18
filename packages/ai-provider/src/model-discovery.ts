import { aiFetch } from './fetch'
import { getProviderAdapter } from './registry'
import { MAX_CATALOG_MODELS, isModelId, modelCatalogBaseUrl } from './model-catalog'
import type { AiModelListErrorCode, AiModelListRequest, AiModelListResponse } from './types'

const TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_PAGES = 20
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

class DiscoveryError extends Error {
  constructor(
    readonly code: AiModelListErrorCode,
    readonly status?: number,
  ) {
    super(code)
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Model list APIs may also expose embeddings, speech, and image-only models. */
function supportsChat(value: unknown, now: number): boolean {
  const row = record(value)
  const id = String(row.id ?? row.name ?? '').replace(/^models\//u, '')
  if (!isModelId(id)) return false
  const shutdown = typeof row.shutdown_date === 'string' ? Date.parse(row.shutdown_date) : NaN
  if (shutdown <= now) return false
  if (
    Array.isArray(row.supportedGenerationMethods) &&
    !row.supportedGenerationMethods.includes('generateContent')
  )
    return false
  if (record(row.capabilities).completion_chat === false) return false
  const output = record(row.architecture).output_modalities
  if (Array.isArray(output) && !output.includes('text')) return false
  const name = id.split('/').at(-1)!
  return (
    !/^(?:text-embedding|embedding|bge-|rerank|whisper|tts-|gpt-image|dall-e|imagen|veo-|sora|doubao-seedream|qwen-image|stable-diffusion|flux[.-]|gpt-audio|gpt-realtime|omni-moderation)/iu.test(
      name,
    ) && !/^gemini-.*(?:image|tts|audio)/iu.test(name)
  )
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new DiscoveryError('too_large')
  }
  if (!response.body) throw new DiscoveryError('invalid_response')
  const reader = response.body.getReader()
  let size = 0
  let text = ''
  const decoder = new TextDecoder()
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new DiscoveryError('too_large')
      text += decoder.decode(chunk.value, { stream: true })
    }
    signal.throwIfAborted()
    return JSON.parse(text + decoder.decode()) as unknown
  } catch (error) {
    cancel()
    if (error instanceof DiscoveryError || signal.aborted) throw error
    throw new DiscoveryError('invalid_response')
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** Read only the configured vendor's structured discovery endpoint. Never follows redirects. */
export async function listModelsForProvider(
  request: AiModelListRequest,
  options: { signal?: AbortSignal; fetch?: FetchLike; timeoutMs?: number; now?: () => number } = {},
): Promise<AiModelListResponse> {
  let timedOut = false
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? TIMEOUT_MS)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  try {
    controller.signal.throwIfAborted()
    if (
      !request ||
      typeof request.provider !== 'string' ||
      typeof request.config?.apiKey !== 'string' ||
      request.config.apiKey.length > 8192 ||
      (request.config.baseUrl !== undefined && typeof request.config.baseUrl !== 'string')
    ) {
      throw new DiscoveryError('invalid_request')
    }
    let adapter
    try {
      adapter = getProviderAdapter(request.provider)
    } catch {
      throw new DiscoveryError('unsupported_provider')
    }
    const apiKey = request.config.apiKey.trim()
    if (!apiKey && request.provider !== 'custom') throw new DiscoveryError('missing_key')
    let endpoint
    try {
      endpoint = adapter.resolveEndpoint({ ...request.config, apiKey, model: '' })
    } catch {
      throw new DiscoveryError('invalid_base_url')
    }
    const baseUrl = modelCatalogBaseUrl(endpoint.baseUrl)
    if (!baseUrl) throw new DiscoveryError('invalid_base_url')
    const url = new URL(
      `${baseUrl}${endpoint.protocol === 'anthropic' && !baseUrl.endsWith('/v1') ? '/v1' : ''}/models`,
    )
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (endpoint.protocol === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      url.searchParams.set('limit', '1000')
    } else if (endpoint.protocol === 'gemini') {
      headers['x-goog-api-key'] = apiKey
      url.searchParams.set('pageSize', '1000')
    } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const models = new Set<string>()
    const cursors = new Set<string>()
    const now = options.now?.() ?? Date.now()
    for (let page = 0; page < MAX_PAGES; page++) {
      controller.signal.throwIfAborted()
      const response = await (options.fetch ?? aiFetch)(url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'manual',
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        const code =
          response.status === 401 || response.status === 403
            ? 'unauthorized'
            : response.status === 404 || response.status === 405
              ? 'unsupported_endpoint'
              : response.status === 429
                ? 'rate_limited'
                : 'upstream_error'
        throw new DiscoveryError(code, response.status)
      }
      const raw = await readJson(response, controller.signal)
      const payload = record(raw)
      const rows =
        endpoint.protocol === 'gemini' ? payload.models : Array.isArray(raw) ? raw : payload.data
      if (!Array.isArray(rows)) throw new DiscoveryError('invalid_response')
      if (rows.length > MAX_CATALOG_MODELS) throw new DiscoveryError('too_large')
      for (const value of rows) {
        if (!supportsChat(value, now)) continue
        const row = record(value)
        const id = String(row.id ?? row.name).replace(/^models\//u, '')
        if (id === apiKey) continue
        models.add(id)
        if (models.size > MAX_CATALOG_MODELS) throw new DiscoveryError('too_large')
      }
      const next =
        endpoint.protocol === 'gemini'
          ? payload.nextPageToken
          : payload.has_more === true
            ? payload.last_id
            : undefined
      if (next === undefined || next === null || next === '') {
        if (payload.has_more === true) throw new DiscoveryError('invalid_response')
        if (!models.size) throw new DiscoveryError('empty_list')
        return { ok: true, catalog: { baseUrl, models: [...models].sort(), fetchedAt: now } }
      }
      if (typeof next !== 'string' || next.length > 2048 || cursors.has(next)) {
        throw new DiscoveryError('invalid_response')
      }
      cursors.add(next)
      url.searchParams.set(
        endpoint.protocol === 'gemini'
          ? 'pageToken'
          : endpoint.protocol === 'anthropic'
            ? 'after_id'
            : 'after',
        next,
      )
    }
    throw new DiscoveryError('too_large')
  } catch (error) {
    // Never return upstream text, URLs, headers, or exception messages to the renderer.
    if (controller.signal.aborted)
      return { ok: false, errorCode: timedOut ? 'timeout' : 'cancelled' }
    return error instanceof DiscoveryError
      ? { ok: false, errorCode: error.code, ...(error.status ? { status: error.status } : {}) }
      : { ok: false, errorCode: 'network' }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
