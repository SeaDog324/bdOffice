import { aiFetch } from './fetch'
import { httpBodyDetail } from './http-error'
import { imageConfigurationError, imageProviderMeta, resolveImageSettings } from './image-providers'
import type {
  AiImageProviderConfig,
  AiImageProviderId,
  AiImageResponse,
  AiProviderConfig,
  AiProviderId,
  AiSettings,
} from './types'
import { AI_CHAT_RESPONSE_TIMEOUT_MS, createStreamWatchdog } from './watchdog'

export interface AiImageOptions {
  model?: string
  size?: string
  aspectRatio?: string
  signal?: AbortSignal
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const OPENAI_SIZES: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '4:3': '1536x1024',
  '3:2': '1536x1024',
  '9:16': '1024x1536',
  '3:4': '1024x1536',
  '2:3': '1024x1536',
}
const QWEN_SIZES: Record<string, string> = {
  '1:1': '2048*2048',
  '16:9': '2688*1536',
  '9:16': '1536*2688',
  '4:3': '2368*1728',
  '3:4': '1728*2368',
  '3:2': '2496*1664',
  '2:3': '1664*2496',
}
const QWEN_LEGACY_SIZES: Record<string, string> = {
  '1:1': '1328*1328',
  '16:9': '1664*928',
  '9:16': '928*1664',
  '4:3': '1472*1104',
  '3:4': '1104*1472',
}
const SEEDREAM_SIZES: Record<string, string> = {
  '1:1': '2048x2048',
  '16:9': '2848x1600',
  '9:16': '1600x2848',
  '4:3': '2304x1728',
  '3:4': '1728x2304',
  '3:2': '2496x1664',
  '2:3': '1664x2496',
}
const GEMINI_RATIOS = [
  '1:1',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
]

function mappedSize(sizes: Record<string, string>, ratio: string, fallback: string): string {
  if (!ratio) return fallback
  const size = sizes[ratio]
  if (!size)
    throw new Error(
      `Unsupported image aspect ratio: ${ratio}. Use ${Object.keys(sizes).join(', ')}.`,
    )
  return size
}

function geminiImageConfig(options: AiImageOptions, ratio: string, model: string) {
  const config: Record<string, string> = {}
  const size = options.size?.trim()
  if (size && size !== 'auto') {
    const dimensions = /^(\d+)[x*](\d+)$/u.exec(size)
    if (dimensions) {
      const width = Number(dimensions[1]),
        height = Number(dimensions[2])
      // Pixel sizes from older tools become Gemini's ratio + resolution tier.
      ratio =
        GEMINI_RATIOS.find((candidate) => {
          const [w, h] = candidate.split(':').map(Number)
          return Math.abs(width / height - w! / h!) < 0.02
        }) ?? ''
      if (!ratio) throw new Error('Gemini image size must use a supported aspect ratio.')
      config.imageSize =
        Math.max(width, height) > 2048 ? '4K' : Math.max(width, height) > 1024 ? '2K' : '1K'
    } else if (['512', '1K', '2K', '4K'].includes(size)) {
      config.imageSize = size
    } else {
      throw new Error('Gemini image size must be 512, 1K, 2K, 4K or width x height.')
    }
  }
  if (ratio) {
    if (!GEMINI_RATIOS.includes(ratio))
      throw new Error(`Unsupported Gemini image aspect ratio: ${ratio}`)
    config.aspectRatio = ratio
  }
  // The legacy 2.5 image model supports aspect ratios but not resolution tiers.
  if (model.startsWith('gemini-2.5-')) delete config.imageSize
  return config
}

function requestFor(
  provider: AiImageProviderId,
  config: AiImageProviderConfig,
  prompt: string,
  options: AiImageOptions,
) {
  const meta = imageProviderMeta(provider)!
  const base = (config.baseUrl?.trim() || meta.defaultBaseUrl).replace(/\/+$/, '')
  const ratio = options.aspectRatio?.trim() === 'auto' ? '' : (options.aspectRatio?.trim() ?? '')
  const size = options.size?.trim()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (meta.protocol === 'gemini-image') {
    headers['x-goog-api-key'] = config.apiKey.trim()
    return {
      url: `${base}/models/${encodeURIComponent(config.model.replace(/^models\//u, ''))}:generateContent`,
      headers,
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: geminiImageConfig(options, ratio, config.model),
        },
      },
    }
  }
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`
  if (meta.protocol === 'qwen-image') {
    const sizes = /^qwen-image-2\.0/u.test(config.model) ? QWEN_SIZES : QWEN_LEGACY_SIZES
    const dimensions =
      size && size !== 'auto' ? size.replace(/x/gu, '*') : mappedSize(sizes, ratio, sizes['1:1']!)
    if (!/^\d+\*\d+$/u.test(dimensions))
      throw new Error('Qwen Image size must be width*height (for example 2048*2048).')
    return {
      url: `${base}/services/aigc/multimodal-generation/generation`,
      headers,
      body: {
        model: config.model,
        input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
        parameters: { n: 1, size: dimensions },
      },
    }
  }
  if (meta.protocol === 'seedream') {
    return {
      url: `${base}/images/generations`,
      headers,
      body: {
        model: config.model,
        prompt,
        size: size || mappedSize(SEEDREAM_SIZES, ratio, '2K'),
        response_format: 'url',
        sequential_image_generation: 'disabled',
        stream: false,
      },
    }
  }
  return {
    url: `${base}/images/generations`,
    headers,
    body: {
      model: config.model,
      prompt,
      n: 1,
      size: size || mappedSize(OPENAI_SIZES, ratio, '1024x1024'),
    },
  }
}

function imageResponse(provider: AiImageProviderId, value: unknown): AiImageResponse {
  const body = record(value)
  const first = record(list(body.data)[0])
  const error = record(body.error)
  const itemError = record(first.error)
  const detail =
    str(error.message) ||
    str(body.error) ||
    str(itemError.message) ||
    (body.code ? str(body.message) || str(body.code) : '')
  if (detail) return { ok: false, error: detail }

  if (provider === 'gemini') {
    const candidate = record(list(body.candidates)[0])
    const parts = list(record(candidate.content).parts).map(record)
    for (const part of parts) {
      if (part.thought === true) continue
      const inline = record(part.inlineData ?? part.inline_data)
      const mime = str(inline.mimeType ?? inline.mime_type)
      const data = str(inline.data)
      if (data && /^image\/(?:png|jpeg|webp)$/u.test(mime))
        return { ok: true, url: `data:${mime};base64,${data}` }
    }
    const reason = str(record(body.promptFeedback).blockReason) || str(candidate.finishReason)
    return { ok: false, error: `Gemini returned no image data${reason ? ` (${reason})` : ''}.` }
  }
  if (provider === 'qwen') {
    const choice = record(list(record(body.output).choices)[0])
    for (const part of list(record(choice.message).content)) {
      const url = str(record(part).image)
      if (url) return { ok: true, url }
    }
  } else {
    const url = str(first.url)
    if (url) return { ok: true, url }
    const b64 = str(first.b64_json)
    if (b64) {
      const format = body.output_format
      const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
      return { ok: true, url: `data:${mime};base64,${b64}` }
    }
  }
  return { ok: false, error: 'Image endpoint returned no image data' }
}

async function generateImage(
  provider: AiImageProviderId,
  savedConfig: AiImageProviderConfig,
  prompt: string,
  options: AiImageOptions,
): Promise<AiImageResponse> {
  const cleanPrompt = prompt.trim()
  if (!cleanPrompt) return { ok: false, error: 'prompt must not be empty' }
  const config = { ...savedConfig, model: options.model?.trim() || savedConfig.model.trim() }
  const error = imageConfigurationError(provider, config)
  if (error) return { ok: false, error }
  try {
    options.signal?.throwIfAborted()
    const request = requestFor(provider, config, cleanPrompt, options)
    const watchdog = createStreamWatchdog(options.signal, AI_CHAT_RESPONSE_TIMEOUT_MS)
    return await watchdog.guard(async () => {
      const response = await aiFetch(request.url, {
        method: 'POST',
        signal: watchdog.signal,
        headers: request.headers,
        body: JSON.stringify(request.body),
      })
      watchdog.touch()
      if (!response.ok)
        return {
          ok: false,
          error: `HTTP ${response.status}: ${httpBodyDetail(await response.text())}`,
        }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        watchdog.signal.throwIfAborted()
        return { ok: false, error: 'Image endpoint returned an invalid JSON response' }
      }
      watchdog.signal.throwIfAborted()
      return imageResponse(provider, body)
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Canonical editor path: chat models, vision inputs and subscription runtimes do not select the image API. */
export function generateImageForSettings(
  settings: AiSettings,
  prompt: string,
  options: AiImageOptions = {},
): Promise<AiImageResponse> {
  const images = resolveImageSettings(settings.imageGeneration, settings)
  return generateImage(images.provider, images.providers[images.provider], prompt, options)
}

/** Backward-compatible call shapes for editor extensions; never interpret a chat model as an image model. */
export function generateImageForProvider(
  config: AiProviderConfig,
  prompt: string,
  options?: AiImageOptions,
): Promise<AiImageResponse>
export function generateImageForProvider(
  provider: AiProviderId,
  config: AiProviderConfig,
  prompt: string,
  options?: AiImageOptions,
): Promise<AiImageResponse>
export function generateImageForProvider(
  providerOrConfig: AiProviderId | AiProviderConfig,
  configOrPrompt: AiProviderConfig | string,
  promptOrOptions: string | AiImageOptions = {},
  explicitOptions: AiImageOptions = {},
): Promise<AiImageResponse> {
  const legacy = typeof providerOrConfig !== 'string'
  const provider = legacy ? 'openai' : providerOrConfig
  const meta = imageProviderMeta(provider)
  if (!meta)
    return Promise.resolve({
      ok: false,
      error: `Unsupported image-generation provider: ${provider}`,
    })
  const config = (legacy ? providerOrConfig : configOrPrompt) as AiProviderConfig
  return generateImage(
    meta.id,
    {
      apiKey: config.apiKey,
      model: config.imageModel?.trim() || meta.defaultModel,
      baseUrl: config.baseUrl,
    },
    (legacy ? configOrPrompt : promptOrOptions) as string,
    (legacy ? promptOrOptions : explicitOptions) as AiImageOptions,
  )
}
