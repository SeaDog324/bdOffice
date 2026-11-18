/** Browser-safe settings surface. Keep Node-backed transports out of renderer bundles. */
export type {
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSettings,
  CodexModelCatalog,
} from './types'
export {
  AI_PROVIDERS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  clampMaxOutputTokens,
} from './providers'
export { getProviderAdapter, modelLacksVision } from './registry'
export { AI_MEDIA_PROVIDERS, imageGenerationAvailable, mediaAnalysisAvailable } from './media'
export { AI_SEARCH_PROVIDERS, resolveAiSearchSettings } from './search-settings'
export {
  AI_IMAGE_PROVIDERS,
  imageConfigurationError,
  imageProviderMeta,
  resolveImageSettings,
} from './image-providers'
export type { AiImageProviderConfig, AiImageProviderId } from './types'

export { activeProvider } from './providers'

export { normalizeCustomProfile } from './custom-profile'
export { endpointSupportsVision } from './registry'
