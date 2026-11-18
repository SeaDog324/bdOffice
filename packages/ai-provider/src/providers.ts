import { defaultAiMediaSettings, resolveAiMediaSettings } from './media'
import { defaultAiSearchSettings, resolveAiSearchSettings } from './search-settings'
import type {
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSettings,
  LegacyAiSettings,
} from './types'

import {
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_IMAGE_MODEL,
  defaultImageSettings,
  resolveImageSettings,
} from './image-providers'
import { normalizeModelCatalog, normalizeModelIds } from './model-catalog'
export { OPENAI_DEFAULT_BASE_URL, OPENAI_DEFAULT_IMAGE_MODEL } from './image-providers'

/** Chinese fallback and visible-answer policy shared by every protocol. */
export const DEFAULT_SYSTEM_PROMPT = [
  '你是 大狗Office 智能办公助手。',
  '遵循应用提供的回复语言规则；未指定时，除非用户明确要求其他语言，否则最终可见回复使用简体中文。',
  '不要展示或索取内部思维链；只提供简洁结论、必要依据、工具执行结果和可执行步骤。',
  '代码、公式、文件路径、协议字段和专有名词按需保持原样。',
].join('\n')

/** Combine the locale policy with an app/skill-specific system prompt. */
export function composeSystemPrompt(system?: string): string {
  const specific = system?.trim()
  // Application locale directives take precedence over the Chinese fallback.
  // Composition is idempotent when a transport already applied this policy.
  if (specific?.endsWith(DEFAULT_SYSTEM_PROMPT)) return specific
  return specific ? `${specific}\n\n${DEFAULT_SYSTEM_PROMPT}` : DEFAULT_SYSTEM_PROMPT
}

/** Direct vendor integrations. The removed 大狗Office/Genspark proxy is intentionally absent. */
export function opencodeSessionHeaders(
  baseUrl: string | undefined,
  sessionId?: string,
): Record<string, string> {
  return baseUrl?.startsWith('https://opencode.ai/')
    ? { 'x-opencode-session': sessionId || crypto.randomUUID() }
    : {}
}

/** Direct vendor catalog; account-based login is owned by the separate account provider. */
export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'anthropic',
    label: 'Claude',
    models: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ],
    defaultModel: 'claude-sonnet-5',
    keyPlaceholder: 'sk-ant-api03-...',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    models: [
      'gemini-3.7-flash',
      'gemini-3.1-pro-preview',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ],
    defaultModel: 'gemini-3.7-flash',
    keyPlaceholder: 'AIza...',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // exactly what GET api.deepseek.com/v1/models serves (2026-09-16):
    // `deepseek-flash` is V4.1 Flash with native vision. The legacy
    // `deepseek-v4-flash` still answers but the model behind it is retired;
    // indirect-route aliases such as `-openrouter` do not belong here either.
    models: ['deepseek-v4-pro', 'deepseek-flash'],
    defaultModel: 'deepseek-v4-pro',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    // GPT-6 uses Responses for reasoning with tools. Existing defaults remain unchanged.
    models: [
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ],
    defaultModel: 'gpt-5.6-terra',
    keyPlaceholder: 'sk-...',
    imageModels: ['gpt-image-2', 'gpt-image-1'],
    defaultImageModel: OPENAI_DEFAULT_IMAGE_MODEL,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    models: ['kimi-k3'],
    defaultModel: 'kimi-k3',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'glm',
    label: 'GLM',
    models: ['glm-5.3', 'glm-5.2', 'glm-5-turbo'],
    defaultModel: 'glm-5.3',
    keyPlaceholder: 'xxxxxxxx.xxxxxxxx',
  },
  {
    id: 'qwen',
    label: 'Qwen',
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash'],
    defaultModel: 'qwen3.8-max',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'doubao',
    label: 'Doubao',
    models: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628'],
    defaultModel: 'doubao-seed-2-1-pro-260628',
    keyPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    models: ['MiniMax-M3', 'MiniMax-M2.7'],
    defaultModel: 'MiniMax-M3',
    keyPlaceholder: 'eyJ...',
  },
  {
    id: 'xai',
    label: 'Grok',
    models: ['grok-4.6', 'grok-4.5'],
    defaultModel: 'grok-4.6',
    keyPlaceholder: 'xai-...',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    models: ['mistral-medium-latest', 'mistral-large-latest', 'mistral-small-latest'],
    defaultModel: 'mistral-medium-latest',
    keyPlaceholder: 'API Key',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    models: [
      'openrouter/auto',
      'anthropic/claude-sonnet-5',
      'openai/gpt-6-astra',
      'openai/gpt-5.6-sol',
      'moonshotai/kimi-k3',
    ],
    defaultModel: 'openrouter/auto',
    keyPlaceholder: 'sk-or-...',
  },
  {
    id: 'requesty',
    label: 'Requesty',
    // Managed policy ids exactly as GET router.requesty.ai/v1/models/managed
    // lists them (2026-09-11): short stable names Requesty routes across
    // providers, used as-is in the model field. The full vendor-prefixed
    // catalog (GET /v1/models, e.g. openai/gpt-4o-mini) works too when typed
    // in. Ids ending "@eu" route through EU providers only.
    models: [
      'claude-sonnet-5',
      'claude-opus-4-8',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gemini-3.7-flash',
      'deepseek-v4-pro',
      'kimi-k3',
    ],
    defaultModel: 'claude-sonnet-5',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'opper',
    label: 'Opper',
    // Pool ids exactly as GET api.opper.ai/v3/models lists them (2026-09-14):
    // a bare name is an Opper pool, and Opper picks the serving provider and
    // region per request. The vendor-prefixed catalog (anthropic/claude-sonnet-4-6,
    // azure/gpt-5, …) pins one provider and works as-is when typed in.
    // Full list at opper.ai/models.
    models: [
      'claude-sonnet-4-6',
      'claude-opus-5',
      'gpt-5.5',
      'gpt-5.4-mini',
      'gemini-3.8-flash',
      'deepseek-v4-pro',
      'kimi-k3',
      'mistral-large-2512',
    ],
    defaultModel: 'claude-sonnet-4-6',
    keyPlaceholder: 'API Key',
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    // Pay-as-you-go gateway (opencode.ai/docs/zen); ids exactly as GET
    // /zen/v1/models lists them (2026-09-03). GPT-5.x, Grok and Muse Spark
    // are served only through the Responses API, which has no protocol here,
    // so they stay out until one exists.
    models: [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'gemini-3.7-flash',
      'gemini-3.1-pro',
      'kimi-k3',
      'kimi-k2.7-code',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'glm-5.2',
      'minimax-m3',
      'qwen3.6-plus',
    ],
    defaultModel: 'claude-sonnet-5',
    keyPlaceholder: 'API Key',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    // $10/month subscription to open-weight coding models (opencode.ai/docs/go),
    // same key as Zen; ids exactly as GET /zen/go/v1/models lists them
    // (2026-09-03). GPT-5.6 Luna, Grok and Muse Spark are Responses-only and
    // left out for the same reason as above.
    models: [
      'kimi-k2.7-code',
      'kimi-k3',
      'glm-5.3',
      'glm-5.3-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'qwen3.8-max',
      'qwen3.8-flash',
      'minimax-m3',
      'mimo-v2.5-pro',
      'longcat-2.0',
    ],
    defaultModel: 'kimi-k2.7-code',
    keyPlaceholder: 'API Key',
  },
  {
    id: 'custom',
    label: 'Custom',
    models: [],
    defaultModel: '',
    keyPlaceholder: 'API Key',
    imageModels: [],
    needsBaseUrl: true,
  },
]

const ALL_PROVIDER_IDS: AiProviderId[] = ['genspark', ...AI_PROVIDERS.map((meta) => meta.id)]

const ADVERTISED_PROVIDER_IDS = new Set<AiProviderId>(AI_PROVIDERS.map((meta) => meta.id))

/** Fresh settings for direct vendor APIs; no integrated 大狗Office account or proxy is selected. */
export function defaultAiSettings(
  defaultApiKeys?: Partial<Record<AiProviderId, string>>,
): AiSettings {
  const providers = {} as AiSettings['providers']
  for (const id of ALL_PROVIDER_IDS) {
    const meta = AI_PROVIDERS.find((candidate) => candidate.id === id)
    providers[id] = {
      apiKey: defaultApiKeys?.[id]?.trim() ?? '',
      model: meta?.defaultModel ?? '',
      imageModel: meta?.defaultImageModel ?? '',
      baseUrl: meta?.needsBaseUrl ? '' : undefined,
    }
  }
  return {
    provider: 'openai',
    providers,
    imageGeneration: defaultImageSettings(defaultApiKeys),
    gskToolsEnabled: false,
    media: defaultAiMediaSettings(),
    search: defaultAiSearchSettings(),
  }
}

/** Resolve an unknown or retired Genspark selection to the direct OpenAI provider. */
export function activeProvider(settings: AiSettings): AiProviderId {
  return ADVERTISED_PROVIDER_IDS.has(settings.provider) ? settings.provider : 'openai'
}

/** Deprecated compatibility helper; 大狗Office/Genspark cloud tools remain permanently disabled. */
export function cloudToolsEnabled(_settings: Pick<AiSettings, 'gskToolsEnabled'>): boolean {
  return false
}

const RETIRED_MODELS: Partial<Record<AiProviderId, Record<string, string>>> = {
  // chat/reasoner retired 2026-07-24 (thinking became a request parameter);
  // V4 Flash and V4 Flash Vision Exp retired 2026-09-10 in favour of V4.1
  // Flash, which carries vision natively. The Genspark pool spelling is
  // accepted too: the vendor API 400s on it (verified 2026-09-16)
  deepseek: {
    'deepseek-chat': 'deepseek-flash',
    'deepseek-reasoner': 'deepseek-flash',
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    'deep-seek-v4.1-flash': 'deepseek-flash',
  },
  // proxy stopped serving bare gpt-5.6 (400) and removed the gemini route
  // entirely (405), verified 2026-08-31; gemini selections fall back to the
  // provider default since no gemini id is served at all
  genspark: {
    'gpt-5.6': 'gpt-5.6-terra',
    'gemini-3.1-pro-preview': 'claude-opus-4-7',
    'gemini-3-flash-preview': 'claude-opus-4-7',
    'gemini-3.7-flash': 'claude-opus-4-7',
  },
}

/**
 * Per-turn output cap applied when the settings carry none. The historic 8192
 * was the budget a reasoning model burns on thinking before it writes any prose,
 * and too small for a large sheet DSL or long-form generation in one turn. Models
 * whose own ceiling is lower reject this and are retried at that ceiling
 * (see output-cap.ts).
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768
/** bounds accepted for AiSettings.maxOutputTokens: below the first a short answer cannot even finish, above the second one turn risks the whole context window */
export const MIN_MAX_OUTPUT_TOKENS = 1024
export const MAX_MAX_OUTPUT_TOKENS = 131072

/** Out-of-range or non-finite input falls back to a bound / the default (a mistyped settings field must not kill AI features) */
export function clampMaxOutputTokens(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_MAX_OUTPUT_TOKENS
  return Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, n))
}

/** The effective per-turn output cap of a settings object (clamped; absent → default) */
export function maxOutputTokensOf(
  settings: Pick<AiSettings, 'maxOutputTokens'> | null | undefined,
): number {
  return settings?.maxOutputTokens === undefined
    ? DEFAULT_MAX_OUTPUT_TOKENS
    : clampMaxOutputTokens(settings.maxOutputTokens)
}

const ONE_PROTOCOL_MODELS = new Set(['gpt-4o-mini', 'gpt-4o', 'gpt-5', 'gpt-5-mini', 'o4-mini'])

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function storedString(value: unknown, fallback: string | undefined): string | undefined {
  if (value === undefined) return fallback
  return typeof value === 'string' ? value.trim() : fallback
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeConfig(
  id: AiProviderId,
  value: unknown,
  fallback: AiProviderConfig,
): AiProviderConfig {
  const raw = objectRecord(value)
  if (!raw) return { ...fallback }

  // Settings produced by the short-lived single-protocol build copied the
  // OpenAI endpoint/model into every historical provider slot. Reset those
  // untouched shadow slots when restoring the vendor catalog.
  const isSingleProtocolShadow =
    id !== 'openai' &&
    id !== 'custom' &&
    cleanString(raw.baseUrl).replace(/\/+$/, '') === OPENAI_DEFAULT_BASE_URL &&
    ONE_PROTOCOL_MODELS.has(cleanString(raw.model)) &&
    !cleanString(raw.apiKey)
  if (isSingleProtocolShadow) return { ...fallback }

  const replacement = RETIRED_MODELS[id]?.[cleanString(raw.model)]
  const config: AiProviderConfig = {
    apiKey: storedString(raw.apiKey, fallback.apiKey) ?? '',
    model: replacement || storedString(raw.model, fallback.model) || '',
    imageModel: storedString(raw.imageModel, fallback.imageModel),
  }
  if (raw.baseUrl !== undefined || fallback.baseUrl !== undefined) {
    config.baseUrl = storedString(raw.baseUrl, fallback.baseUrl)
  }
  const modelCatalog = normalizeModelCatalog(raw.modelCatalog)
  if (modelCatalog) config.modelCatalog = modelCatalog
  const customModels = normalizeModelIds(raw.customModels, 100)
  if (customModels.length) config.customModels = customModels
  return config
}

/**
 * Merge persisted settings over current defaults. The pre-provider shape is
 * migrated to Custom because its endpoint is user-defined. Historical
 * Genspark selections migrate to direct OpenAI without restoring login/proxy
 * behavior.
 */
export function resolveAiSettings(
  stored: Partial<AiSettings> & LegacyAiSettings,
  defaults: AiSettings,
): AiSettings {
  const source = objectRecord(stored) ?? {}
  const providerValues = objectRecord(source.providers)
  const providers = {} as AiSettings['providers']

  for (const id of ALL_PROVIDER_IDS) {
    providers[id] = normalizeConfig(id, providerValues?.[id], defaults.providers[id])
  }

  if (!providerValues) {
    const hasLegacyConfig = ['apiKey', 'model', 'baseUrl', 'imageModel'].some(
      (key) => source[key] !== undefined,
    )
    if (hasLegacyConfig) {
      providers.custom = {
        apiKey: cleanString(source.apiKey),
        model: cleanString(source.model) || defaults.providers.openai.model,
        imageModel: cleanString(source.imageModel) || OPENAI_DEFAULT_IMAGE_MODEL,
        baseUrl: cleanString(source.baseUrl) || OPENAI_DEFAULT_BASE_URL,
      }
      return {
        provider: 'custom',
        providers,
        imageGeneration: resolveImageSettings(source.imageGeneration, {
          provider: 'custom',
          providers,
        }),
        gskToolsEnabled: false,
      }
    }
  }

  const storedProvider = cleanString(source.provider) as AiProviderId
  const provider = ADVERTISED_PROVIDER_IDS.has(storedProvider) ? storedProvider : defaults.provider
  return {
    provider,
    providers,
    imageGeneration: resolveImageSettings(source.imageGeneration, { provider, providers }),
    gskToolsEnabled: false,
    media: resolveAiMediaSettings(stored.media ?? defaults.media),
    search: resolveAiSearchSettings(stored.search ?? defaults.search),
    // clamped on read: a hand-edited settings file with an absurd cap must not be
    // forwarded to the endpoint verbatim
    ...(source.maxOutputTokens !== undefined || defaults.maxOutputTokens !== undefined
      ? {
          maxOutputTokens: clampMaxOutputTokens(source.maxOutputTokens ?? defaults.maxOutputTokens),
        }
      : {}),
  }
}
