import { modelLacksVision as currentModelLacksVision } from './model-heuristics'
import { ANTHROPIC_BASE_URL } from './protocols/anthropic'
import { GEMINI_BASE_URL } from './protocols/gemini'
import { AI_PROVIDERS, OPENAI_DEFAULT_BASE_URL } from './providers'
import type { AiProviderConfig, AiProviderId, AiProviderMeta } from './types'

/** Native Anthropic, native Gemini, and OpenAI-compatible wire protocols. */
export type AiProtocol = 'anthropic' | 'gemini' | 'openai-compatible' | 'openai-responses'

/** GPT-6 tool turns require Responses; do not downgrade reasoning or discard tools. */
export function modelUsesResponses(model: string): boolean {
  return /^(?:openai\/)?gpt-6(?:\.\d+)?-(?:astra|sol|terra|luna)(?:-\d{4}-\d{2}-\d{2})?$/i.test(
    model.trim(),
  )
}

export interface ProviderCapabilities {
  /** Every advertised provider uses a key supplied by the user. */
  auth: 'api-key'
  /** Whether the chat endpoint can receive image content. */
  vision: boolean
}

export interface ResolvedEndpoint {
  protocol: AiProtocol
  baseUrl: string
  /** Official OpenAI models use developer instructions; compatible gateways use system. */
  instructionRole?: 'developer' | 'system'
  /** Omit temperature when a selected model rejects sampling controls. */
  omitTemperature?: boolean
  /** Use OpenAI's current output-token field instead of the compatible legacy field. */
  useMaxCompletionTokens?: boolean
  /** Optional vendor request fields merged into the OpenAI-compatible body. */
  bodyExtras?: Record<string, unknown>
  /** id to put on the wire when the vendor spells the configured model differently */
  model?: string
}

export interface ProviderAdapter {
  meta: AiProviderMeta
  capabilities: ProviderCapabilities
  resolveEndpoint(config: AiProviderConfig): ResolvedEndpoint
}

function metaOf(id: AiProviderId): AiProviderMeta {
  const meta = AI_PROVIDERS.find((candidate) => candidate.id === id)
  if (!meta) throw new Error(`Provider is not advertised: ${id}`)
  return meta
}

/**
 * Model families that fix sampling and reject a temperature field, on any
 * route — vendor API, the Genspark proxy, OpenRouter's vendor-prefixed ids,
 * or a mirror behind a custom base URL. Kimi K3 answers "only 1 is allowed";
 * OpenAI's GPT-5 and GPT-6 reasoning families reject any temperature other
 * than the default outright, and the o-series reasoning models (o1/o3/o4) likewise
 * only accept the default. Google's Gemini 3 docs strongly recommend keeping
 * the default temperature of 1.0 for the whole Gemini 3 family, since lower
 * values may cause looping or degraded reasoning, so our hard-coded 0.3
 * must not be sent there either.
 */
export function modelHasFixedSampling(model: string): boolean {
  return /(^|\/)(kimi-k3([^\w]|$)|gpt-[5-9]([^\w]|$)|gemini-3([^\w]|$)|o1(-mini|-preview)?([^\w]|$)|o3(-mini)?([^\w]|$)|o4-mini([^\w]|$))/i.test(
    model,
  )
}

/**
 * Model ids that reject image input even under a vision-capable provider.
 * DeepSeek V4 Pro and V4 Flash are text-only; V4.1 Flash and the -vision*
 * branches take images, so they fall through and receive screenshots.
 */
export function modelLacksVision(model: string): boolean {
  return /(^|\/)deep-?seek-v4-(?:pro(?:$|-)|flash(?!-vision))/i.test(model)
}

/** Models that require reasoning content to be echoed across tool turns. */
export function modelEchoesReasoning(model: string): boolean {
  return /(^|\/)(minimax-m|deep-?seek-(v4|flash))/i.test(model)
}

const DEEPSEEK_NON_THINKING = { thinking: { type: 'disabled' } }

/**
 * Accept the versioned upstream alias without changing BigDog's stored model
 * IDs or direct API defaults; only the outgoing request uses the wire spelling.
 */
const DEEPSEEK_WIRE_IDS: Record<string, string> = { ['deep-seek-v4.1-flash']: 'deepseek-flash' }

/**
 * OpenCode Zen / Go (opencode.ai) are protocol passthrough gateways: each
 * model is served on exactly one vendor protocol and the other paths answer
 * 500 (verified 2026-09-03 against the public free tier), so the route is
 * picked per model id the way OpenCode's own client does (models.dev
 * `provider.npm`). The two tiers route the same vendor differently — MiniMax
 * is chat-completions on Zen but Anthropic Messages on Go — hence one table
 * each. Every Kimi id omits temperature, mirroring the direct Kimi adapter.
 */
const OPENCODE_GATEWAY_ROOTS = {
  zen: 'https://opencode.ai/zen',
  go: 'https://opencode.ai/zen/go',
} as const

/**
 * Stored provider settings are user data: a custom base URL must be a
 * bounded http(s) URL. Anything else (file:/javascript: schemes, megabyte
 * strings) would misroute gateway traffic or overflow request builders.
 */
function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const candidate = (raw ?? fallback).trim()
  if (candidate === '' || candidate.length > 2048) {
    throw new Error('Base URL must be a non-empty http(s) URL under 2048 characters')
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('Base URL must be a valid http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL must use http or https')
  }
  return candidate
}

function opencodeEndpoint(
  root: string,
  routes: { anthropic: RegExp; gemini?: RegExp },
): (config: AiProviderConfig) => ResolvedEndpoint {
  return (config) => {
    // a stored base URL replaces the gateway root; the documented `/v1` API base is tolerated
    const base = normalizeBaseUrl(config.baseUrl, root).replace(/\/+$/, '').replace(/\/v1$/, '')
    const model = config.model ?? ''
    const omit =
      model !== '' && (modelHasFixedSampling(model) || model.toLowerCase().startsWith('kimi-'))
    const sampling = omit ? { omitTemperature: true as const } : {}
    if (routes.anthropic.test(model)) return { protocol: 'anthropic', baseUrl: base, ...sampling }
    if (routes.gemini?.test(model)) {
      return { protocol: 'gemini', baseUrl: `${base}/v1`, ...sampling }
    }
    return { protocol: 'openai-compatible', baseUrl: `${base}/v1`, ...sampling }
  }
}

/** a stored baseUrl overrides the default endpoint (regional mirrors, e.g. api.moonshot.cn vs .ai) */
function fixedEndpoint(
  protocol: AiProtocol,
  baseUrl: string,
  extras?: {
    omitTemperature?: boolean
    useMaxCompletionTokens?: boolean
    bodyExtras?: Record<string, unknown>
  },
) {
  return (config: AiProviderConfig): ResolvedEndpoint => {
    const resolvedBaseUrl = normalizeBaseUrl(config.baseUrl || undefined, baseUrl).replace(
      /\/+$/,
      '',
    )
    const officialOpenAi = resolvedBaseUrl === OPENAI_DEFAULT_BASE_URL
    const omitTemperature = extras?.omitTemperature || modelHasFixedSampling(config.model)
    const useMaxCompletionTokens = extras?.useMaxCompletionTokens && officialOpenAi
    return {
      protocol,
      baseUrl: resolvedBaseUrl,
      ...(officialOpenAi ? { instructionRole: 'developer' as const } : {}),
      ...(omitTemperature ? { omitTemperature: true } : {}),
      ...(useMaxCompletionTokens ? { useMaxCompletionTokens: true } : {}),
      ...(extras?.bodyExtras ? { bodyExtras: extras.bodyExtras } : {}),
    }
  }
}

/** Direct provider registry. `genspark` is deliberately not registered. */
export const AI_PROVIDER_ADAPTERS: Partial<Record<AiProviderId, ProviderAdapter>> = {
  anthropic: {
    meta: metaOf('anthropic'),
    capabilities: { auth: 'api-key', vision: true },
    resolveEndpoint: fixedEndpoint('anthropic', ANTHROPIC_BASE_URL),
  },
  gemini: {
    meta: metaOf('gemini'),
    capabilities: { auth: 'api-key', vision: true },
    resolveEndpoint: fixedEndpoint('gemini', GEMINI_BASE_URL),
  },
  deepseek: {
    meta: metaOf('deepseek'),
    capabilities: { auth: 'api-key', vision: true },
    resolveEndpoint(config) {
      const wire = DEEPSEEK_WIRE_IDS[config.model]
      return {
        ...fixedEndpoint('openai-compatible', 'https://api.deepseek.com', {
          bodyExtras: DEEPSEEK_NON_THINKING,
        })(config),
        ...(wire ? { model: wire } : {}),
      }
    },
  },
  openai: {
    meta: metaOf('openai'),
    capabilities: { auth: 'api-key', vision: true },
    resolveEndpoint(config) {
      return fixedEndpoint(
        modelUsesResponses(config.model) ? 'openai-responses' : 'openai-compatible',
        OPENAI_DEFAULT_BASE_URL,
        {
          useMaxCompletionTokens: true,
        },
      )(config)
    },
  },
  kimi: {
    meta: metaOf('kimi'),
    capabilities: { auth: 'api-key', vision: true },
    resolveEndpoint: fixedEndpoint('openai-compatible', 'https://api.moonshot.ai/v1', {
      omitTemperature: true,
    }),
  },
  glm: {
    meta: metaOf('glm'),
    capabilities: { auth: 'api-key', vision: false },
    resolveEndpoint: fixedEndpoint('openai-compatible', 'https://open.bigmodel.cn/api/paas/v4'),
  },
  qwen: {
    meta: metaOf('qwen'),
    capabilities: { auth: 'api-key', vision: false },
    resolveEndpoint: fixedEndpoint(
      'openai-compatible',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    ),
  },
  doubao: {
    meta: metaOf('doubao'),
    capabilities: { auth: 'api-key', vision: true },
    resolveEndpoint: fixedEndpoint('openai-compatible', 'https://ark.cn-beijing.volces.com/api/v3'),
  },
  minimax: {
    meta: metaOf('minimax'),
    capabilities: { auth: 'api-key', vision: false },
    resolveEndpoint: fixedEndpoint('openai-compatible', 'https://api.minimax.io/v1'),
  },
  xai: {
    meta: metaOf('xai'),
    capabilities: { auth: 'api-key', vision: true },
    resolveEndpoint: fixedEndpoint('openai-compatible', 'https://api.x.ai/v1'),
  },
  mistral: {
    meta: metaOf('mistral'),
    capabilities: { auth: 'api-key', vision: false },
    resolveEndpoint: fixedEndpoint('openai-compatible', 'https://api.mistral.ai/v1'),
  },
  openrouter: {
    meta: metaOf('openrouter'),
    capabilities: { auth: 'api-key', vision: true },
    resolveEndpoint: fixedEndpoint('openai-compatible', 'https://openrouter.ai/api/v1'),
  },
  requesty: {
    meta: metaOf('requesty'),
    capabilities: { auth: 'api-key', vision: true },
    // a stored base URL selects a regional router (https://router.eu.requesty.ai/v1 for the EU)
    resolveEndpoint: fixedEndpoint('openai-compatible', 'https://router.requesty.ai/v1'),
  },
  opper: {
    meta: metaOf('opper'),
    capabilities: { auth: 'api-key', vision: true },
    // one chat-completions endpoint for every pool and vendor route; the model id picks it
    resolveEndpoint: fixedEndpoint('openai-compatible', 'https://api.opper.ai/v3/compat'),
  },
  'opencode-zen': {
    meta: metaOf('opencode-zen'),
    capabilities: { auth: 'api-key', vision: true },
    // Claude and Qwen ride /v1/messages, Gemini its native generateContent path
    resolveEndpoint: opencodeEndpoint(OPENCODE_GATEWAY_ROOTS.zen, {
      anthropic: /^(claude-|qwen)/,
      gemini: /^gemini-/,
    }),
  },
  'opencode-go': {
    meta: metaOf('opencode-go'),
    capabilities: { auth: 'api-key', vision: true },
    // MiniMax and Qwen 3.8 Flash ride /v1/messages; the rest is chat-completions
    // (the Go docs table lists every Qwen on Messages, but the client config
    // OpenCode ships routes only 3.8 Flash there — follow the running client)
    resolveEndpoint: opencodeEndpoint(OPENCODE_GATEWAY_ROOTS.go, {
      anthropic: /^(minimax-|qwen3\.8-flash$)/,
    }),
  },
  custom: {
    meta: metaOf('custom'),
    capabilities: { auth: 'api-key', vision: true },
    resolveEndpoint(config) {
      if (!config.baseUrl?.trim()) throw new Error('A custom provider requires a Base URL')
      const baseUrl = normalizeBaseUrl(config.baseUrl, '').replace(/\/+$/, '')
      return {
        protocol: modelUsesResponses(config.model) ? 'openai-responses' : 'openai-compatible',
        baseUrl,
        ...(baseUrl === OPENAI_DEFAULT_BASE_URL
          ? { instructionRole: 'developer' as const, useMaxCompletionTokens: true }
          : {}),
        ...(modelHasFixedSampling(config.model) ? { omitTemperature: true } : {}),
      }
    },
  },
}

/** Throws for removed or unknown ids from hand-edited historical settings. */
export function getProviderAdapter(provider: AiProviderId): ProviderAdapter {
  const adapter = AI_PROVIDER_ADAPTERS[provider]
  if (!adapter) throw new Error(`Unknown provider: ${provider}`)
  return adapter
}

export function endpointSupportsVision(settings: import('./types').AiSettings): boolean {
  if (settings.accountProvider) return false
  const id = settings.provider
  const config = settings.providers[id]
  return (
    !!config &&
    (id === 'minimax'
      ? /^MiniMax-M3/i.test(config.model)
      : getProviderAdapter(id).capabilities.vision) &&
    !currentModelLacksVision(config.model)
  )
}
