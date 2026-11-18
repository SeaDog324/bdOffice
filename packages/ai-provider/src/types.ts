import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'

/** `genspark` remains readable only for settings migration; every other id is a direct provider. */
export type AiProviderId =
  | 'genspark'
  | 'codex'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'openai'
  | 'kimi'
  | 'glm'
  | 'qwen'
  | 'doubao'
  | 'minimax'
  | 'xai'
  | 'mistral'
  | 'openrouter'
  | 'requesty'
  | 'opper'
  | 'opencode-zen'
  | 'opencode-go'
  | 'custom'

export interface AiProviderConfig {
  apiKey: string
  model: string
  /** Legacy image setting, retained for migration. New writes use imageGeneration. */
  imageModel?: string | undefined
  /** required for custom; for other direct providers it overrides the default endpoint (regional mirrors) */
  baseUrl?: string | undefined
  /** Last successful upstream chat catalog; never contains credentials. */
  modelCatalog?: AiModelCatalog | undefined
  /** Explicit user-entered IDs remain available after upstream refreshes. */
  customModels?: string[] | undefined
  /** optional Codex CLI override; empty means auto-detect the current authenticated install */
  cliPath?: string | undefined
}

/** Live picker data returned by Codex app-server's model/list method. */
export interface CodexModelCatalog {
  models: string[]
  defaultModel: string
}

export interface AiModelCatalog {
  baseUrl: string
  models: string[]
  fetchedAt: number
}

export type AiModelListErrorCode =
  | 'invalid_request'
  | 'missing_key'
  | 'invalid_base_url'
  | 'unsupported_provider'
  | 'unauthorized'
  | 'unsupported_endpoint'
  | 'rate_limited'
  | 'upstream_error'
  | 'invalid_response'
  | 'empty_list'
  | 'too_large'
  | 'timeout'
  | 'cancelled'
  | 'network'

export interface AiModelListRequest {
  requestId: string
  provider: AiProviderId
  config: Pick<AiProviderConfig, 'apiKey' | 'baseUrl'>
}

export type AiModelListResponse =
  | { ok: true; catalog: AiModelCatalog }
  | { ok: false; errorCode: AiModelListErrorCode; status?: number }

export interface AiProviderMeta {
  id: AiProviderId
  label: string
  models: string[]
  defaultModel: string
  keyPlaceholder: string
  /** Deprecated chat-catalog metadata; image generation has its own vendor catalog. */
  imageModels?: string[]
  /** Deprecated; retained for settings migration and extension compatibility. */
  defaultImageModel?: string
  needsBaseUrl?: boolean
  needsCliPath?: boolean
}

/** Image generation / media analysis backends (separate from the chat provider) */
export type AiMediaProviderId =
  'genspark' | 'openai' | 'gemini' | 'doubao' | 'glm' | 'xai' | 'qwen' | 'minimax' | 'custom'

/** wire shape of the image endpoint */
export type AiMediaImageProtocol = 'openai-images' | 'gemini' | 'dashscope' | 'minimax'
/** wire shape of the understanding endpoint */
export type AiAnalysisProtocol = 'openai-chat' | 'gemini'

export interface AiMediaProviderConfig {
  apiKey: string
  /** required for custom; for the others it overrides the official endpoint (regional mirrors) */
  baseUrl?: string | undefined
  /** image generation model (empty = the provider default) */
  imageModel: string
  /** image/video understanding model (empty = the provider default) */
  analysisModel: string
}

export interface AiMediaProviderMeta {
  id: AiMediaProviderId
  label: string
  /** one-line English blurb shown on the provider card */
  description: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
  /** '' for genspark (gsk login) and custom (user-supplied) */
  defaultBaseUrl: string
  /** absent = the provider does not generate images */
  imageProtocol?: AiMediaImageProtocol
  imageModels: string[]
  defaultImageModel: string
  /** absent = the provider does not analyze media */
  analysisProtocol?: AiAnalysisProtocol
  analysisModels: string[]
  defaultAnalysisModel: string
  /** the analysis model accepts video input (Gemini natively; OpenAI-compatible vendors via a video_url part) */
  videoAnalysis: boolean
}

export interface AiMediaSettings {
  /** provider behind generate_image */
  imageProvider: AiMediaProviderId
  /** provider behind analyze_media for images */
  analysisProvider: AiMediaProviderId
  /** provider behind analyze_media when the input has video/audio (only video-capable vendors qualify) */
  videoAnalysisProvider: AiMediaProviderId
  providers: Record<AiMediaProviderId, AiMediaProviderConfig>
  /** pre-catalog shape (one provider for both); migrated by resolveAiMediaSettings */
  provider?: AiMediaProviderId | undefined
}

/** web/image search backends; Parallel supports both a user key and free keyless search */
export type AiSearchProviderId = 'genspark' | 'serper' | 'tavily' | 'parallel'

export interface AiSearchProviderMeta {
  id: AiSearchProviderId
  label: string
  keyPlaceholder: string
  /** the backend also serves image search (otherwise image search falls back to free sources) */
  imageSearch: boolean
}

export interface AiSearchSettings {
  provider: AiSearchProviderId
  providers: Record<Exclude<AiSearchProviderId, 'genspark'>, { apiKey: string }>
}

/** Compatibility probe for older editor interfaces. No Genspark login is installed in BigDog. */
export interface GenSparkAccountStatus {
  loggedIn: boolean
}

export interface AiSettings {
  /** Main-process read-only connection hint. Never used as authority or persisted. */
  accountProvider?: 'codex' | 'claude'
  provider: AiProviderId
  providers: Record<AiProviderId, AiProviderConfig>
  /** Optional native media/search capabilities; never enable a Genspark account fallback. */
  media?: AiMediaSettings | undefined
  search?: AiSearchSettings | undefined
  /** Independent text-to-image APIs; never follows chat or account runtime selection. */
  imageGeneration?: AiImageSettings
  /** Deprecated compatibility field; cloud/Genspark tools are no longer used. */
  gskToolsEnabled?: boolean
  /**
   * Output-token cap for ONE model turn of agent runs (default
   * DEFAULT_MAX_OUTPUT_TOKENS). Reasoning models bill their thinking against
   * this same budget, so a heavy edit turn can consume all of it and close with
   * finish_reason=length and no prose at all — raising it is the user's lever
   * (absent = the default, so pre-existing settings files keep working).
   */
  maxOutputTokens?: number | undefined
}

export type AiImageProviderId = 'openai' | 'gemini' | 'qwen' | 'doubao' | 'custom'

export type AiImageProtocol = 'openai-images' | 'gemini-image' | 'qwen-image' | 'seedream'

export interface AiImageProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string | undefined
}

export interface AiImageSettings {
  provider: AiImageProviderId
  providers: Record<AiImageProviderId, AiImageProviderConfig>
}

export interface AiImageProviderMeta {
  id: AiImageProviderId
  label: string
  protocol: AiImageProtocol
  models: string[]
  defaultModel: string
  defaultBaseUrl: string
  keyPlaceholder: string
}

/** Text-to-image request routed to the independently selected image provider. */
export interface AiImageRequest {
  settings: AiSettings
  prompt: string
  /** Optional vendor-specific size; omit to use the adapter default. */
  size?: string
  /** Friendly aspect ratio, translated by each vendor adapter. */
  aspectRatio?: string
  /** Per-request override within the selected image provider; otherwise its saved model is used. */
  model?: string
}

export interface AiImageResponse {
  ok: boolean
  url?: string
  error?: string
}

/** pre-provider settings shape (single OpenAI-compatible endpoint); migrated into "custom" */
export interface LegacyAiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
  imageModel?: string
}

export interface AiChatRequest {
  settings: AiSettings
  system: string
  user: string
}

export interface AiChatResponse {
  ok: boolean
  content?: string
  error?: string
}

export interface AiStreamRequest {
  requestId: string
  /** Stable renderer transport id used to retain native provider sessions. */
  sessionId?: string
  settings: AiSettings
  system: string
  messages: AgentMessage[]
  tools?: AgentToolDef[]
  maxTokens?: number
}

export interface AiStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive so the renderer can tell a live stream from a dead one;
   * 'reasoning' = model thinking delta (text carries it), stored for interleaved-thinking echo */
  type: 'delta' | 'reasoning' | 'tool-call' | 'tool-request' | 'usage' | 'done' | 'error' | 'ping'
  text?: string
  /** complete parsed tool call (emitted once its arguments finish streaming) */
  toolCall?: AgentToolCall
  toolRequestId?: string
  error?: string
  /** machine-readable error cause ('timeout', exhausted 'credits', 'network' connectivity failure, 'overloaded' capacity/rate limit); lets the renderer localize the message */
  usage?: import('@genoffice/agent-core').AgentTokenUsage
  errorCode?: 'timeout' | 'credits' | 'network' | 'overloaded' | 'region'
  /** normalized stop reason carried on 'done' ('max_tokens' = output cut off by the token limit) */
  stopReason?: string
}

export type AiCustomProtocol = 'openai-compatible' | 'anthropic' | 'gemini'

export interface AiCustomCompat {
  /** the endpoint 400s on a temperature field (fixed-sampling models behind a proxy) */
  omitTemperature?: boolean | undefined
  /** the endpoint wants `reasoning_content` echoed back on assistant tool turns */
  echoReasoning?: boolean | undefined
  /** false declares a text-only endpoint so screenshots are never sent to it */
  vision?: boolean | undefined
  /** send the output cap as `max_completion_tokens` (OpenAI renamed field) */
  useMaxCompletionTokens?: boolean | undefined
}

export interface AiCustomModelProfile {
  id: string
  /** the id to put on the wire when the endpoint spells this model differently */
  alias?: string | undefined
  /** display name for the picker (a vendor's marketing spelling of the id) */
  name?: string | undefined
  /** declared capabilities; absent = inherit the endpoint compat, then heuristics */
  vision?: boolean | undefined
  omitTemperature?: boolean | undefined
  echoReasoning?: boolean | undefined
  useMaxCompletionTokens?: boolean | undefined
  /** this model's per-turn output ceiling; a server 400s anything above it */
  maxTokens?: number | undefined
  /** the model's context window, when the endpoint publishes one */
  contextWindow?: number | undefined
}

export interface AiCustomProfile {
  /** wire protocol; absent means 'openai-compatible' (the pre-profile shape) */
  api?: AiCustomProtocol | undefined
  /**
   * Name of an environment variable the main process resolves to the key at
   * request time. Lets a settings file carry no secret, so it can be synced or
   * shared; an inline `apiKey` always wins.
   */
  apiKeyEnv?: string | undefined
  /** static request headers (tenant ids, gateway routing keys) */
  headers?: Record<string, string> | undefined
  /** stream idle budget for slow local servers (quantized models take minutes to first token) */
  idleTimeoutMs?: number | undefined
  /** endpoint-wide vendor switches, overridden per model by `modelProfiles` */
  compat?: AiCustomCompat | undefined
  /** vendor-specific fields merged into the request body (vLLM `chat_template_kwargs`, …) */
  bodyExtras?: Record<string, unknown> | undefined
  /** per-model declarations, matched to the configured id on request */
  modelProfiles?: AiCustomModelProfile[] | undefined
  /**
   * Capability facts the last `/models` probe observed, kept beside the id list
   * as a cache. They answer for a model the user has not declared — the whole
   * point, since a gateway knows things no shipped heuristic does — and they
   * are replaced wholesale by the next probe, so a model the server stops
   * serving stops being described. The user's `modelProfiles` always outrank
   * them.
   */
  probedProfiles?: AiCustomModelProfile[] | undefined
}
