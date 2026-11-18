import type {
  AiImageProviderConfig,
  AiImageProviderId,
  AiImageProviderMeta,
  AiImageSettings,
  AiProviderId,
  AiSettings,
} from './types'

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const OPENAI_DEFAULT_IMAGE_MODEL = 'gpt-image-2'

/** Text-to-image APIs, not a list of chat models with vision input. */
export const AI_IMAGE_PROVIDERS: readonly AiImageProviderMeta[] = [
  {
    id: 'openai',
    label: 'OpenAI · GPT Image',
    protocol: 'openai-images',
    models: ['gpt-image-2'],
    defaultModel: OPENAI_DEFAULT_IMAGE_MODEL,
    defaultBaseUrl: OPENAI_DEFAULT_BASE_URL,
    keyPlaceholder: 'sk-…',
  },
  {
    id: 'gemini',
    label: 'Google · Gemini Image',
    protocol: 'gemini-image',
    models: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'],
    defaultModel: 'gemini-3.1-flash-image',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyPlaceholder: 'AIza…',
  },
  {
    id: 'qwen',
    label: '阿里云 · Qwen Image',
    protocol: 'qwen-image',
    models: ['qwen-image-2.0-pro', 'qwen-image-2.0', 'qwen-image-max', 'qwen-image-plus'],
    defaultModel: 'qwen-image-2.0-pro',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    keyPlaceholder: 'sk-…',
  },
  {
    id: 'doubao',
    label: '火山引擎 · Seedream',
    protocol: 'seedream',
    models: ['doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'],
    defaultModel: 'doubao-seedream-4-5-251128',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyPlaceholder: 'Ark API Key',
  },
  {
    id: 'custom',
    label: 'Custom · OpenAI Images API',
    protocol: 'openai-images',
    models: [],
    defaultModel: '',
    defaultBaseUrl: '',
    keyPlaceholder: 'API Key',
  },
]

export function imageProviderMeta(provider: string): AiImageProviderMeta | undefined {
  return AI_IMAGE_PROVIDERS.find((entry) => entry.id === provider)
}

export function defaultImageSettings(
  keys?: Partial<Record<AiProviderId, string>>,
): AiImageSettings {
  const providers = {} as AiImageSettings['providers']
  for (const meta of AI_IMAGE_PROVIDERS) {
    providers[meta.id] = {
      apiKey: keys?.[meta.id]?.trim() ?? '',
      model: meta.defaultModel,
      baseUrl: '',
    }
  }
  return { provider: 'openai', providers }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/**
 * Migrate once. Once imageGeneration exists, even an explicitly empty key is
 * authoritative: chat edits must never silently refill it or change routing.
 * Preserve legacy compatible gateways as Custom, not as a new native protocol.
 * All legacy slots remain in providers for rollback; no credentials are discarded.
 */
export function resolveImageSettings(
  stored: unknown,
  chat: Pick<AiSettings, 'provider' | 'providers'>,
): AiImageSettings {
  const result = defaultImageSettings()
  if (stored !== undefined) {
    const raw = record(stored)
    const selected = imageProviderMeta(string(raw.provider))
    if (!selected) {
      result.provider = 'custom'
      return result
    }
    result.provider = selected.id
    const providers = record(raw.providers)
    for (const meta of AI_IMAGE_PROVIDERS) {
      const config = record(providers[meta.id])
      result.providers[meta.id] = {
        apiKey: string(config.apiKey),
        model: string(config.model, meta.defaultModel),
        baseUrl: string(config.baseUrl),
      }
    }
    return result
  }

  const doubaoBase = chat.providers.doubao?.baseUrl?.trim().replace(/\/+$/, '')
  const nativeSeedream = !doubaoBase || doubaoBase === imageProviderMeta('doubao')!.defaultBaseUrl
  for (const id of ['openai', 'custom', 'doubao'] as const) {
    const old = chat.providers[id]
    if (id === 'doubao' && !nativeSeedream) continue
    if (old && (id === 'openai' || old.imageModel?.trim())) {
      result.providers[id] = {
        apiKey: string(old.apiKey),
        model: string(old.imageModel) || result.providers[id].model,
        baseUrl: string(old.baseUrl),
      }
    }
  }
  const selected = chat.provider
  if (selected === 'openai' || selected === 'custom' || (selected === 'doubao' && nativeSeedream)) {
    result.provider = selected
  } else {
    const old = chat.providers[selected]
    const wasCompatible = !['genspark', 'anthropic', 'gemini'].includes(selected)
    if (wasCompatible && old?.imageModel?.trim() && old.baseUrl?.trim()) {
      result.provider = 'custom'
      result.providers.custom = {
        apiKey: string(old.apiKey),
        model: string(old.imageModel),
        baseUrl: string(old.baseUrl),
      }
    }
  }
  return result
}

/** Local validation only: does not authenticate or make a billable request. */
export function imageConfigurationError(
  provider: AiImageProviderId,
  config: AiImageProviderConfig,
  language = 'en',
): string | undefined {
  const zh = /^zh(?:-|$)/u.test(language)
  const meta = imageProviderMeta(provider)
  if (!meta)
    return zh
      ? '不支持此生图服务，请重新选择厂商。'
      : `Unsupported image-generation provider: ${provider}`
  if (!config.model.trim())
    return zh
      ? '请填写生图模型 ID。'
      : 'Configure an image-generation model in Settings → AI models → Image generation.'
  if (provider !== 'custom' && !config.apiKey.trim()) {
    return zh
      ? `请填写 ${meta.label} 的生图 API Key。`
      : `Configure the image-generation API key for ${meta.label} in Settings → AI models → Image generation.`
  }
  const base = config.baseUrl?.trim() || meta.defaultBaseUrl
  try {
    const url = new URL(base)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return zh
        ? '生图地址须以 http:// 或 https:// 开头，不含账号、密码、查询参数或片段。'
        : 'Image API Base URL must be an HTTP(S) base address without credentials, query or fragment.'
    }
    if (provider === 'qwen' && /\/compatible-mode(?:\/|$)/u.test(url.pathname)) {
      return zh
        ? 'Qwen Image 请使用原生 /api/v1 地址。'
        : 'Qwen Image uses the native /api/v1 base address, not /compatible-mode/v1.'
    }
  } catch {
    return zh
      ? '请填写有效的生图 API 地址，包含 https://。'
      : 'Configure a valid image API Base URL (including https://).'
  }
  return undefined
}
