import type { AiProviderConfig, AiProviderId } from '@genoffice/ai-provider'
import { activeProvider, defaultAiSettings, resolveAiSettings } from '@genoffice/ai-provider'

export interface NamingProvider {
  provider: AiProviderId
  config: AiProviderConfig
}

/** File naming uses the existing API selection. Native accounts are handled by the shell bridge. */
export function resolveNamingProvider(stored: unknown): NamingProvider | null {
  const settings = resolveAiSettings(
    (stored && typeof stored === 'object' ? stored : {}) as Parameters<typeof resolveAiSettings>[0],
    defaultAiSettings(),
  )
  const provider = activeProvider(settings)
  const config = settings.providers[provider]
  if (!config?.apiKey?.trim() || !config.model?.trim()) return null
  return { provider, config }
}
