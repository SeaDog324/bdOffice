import {
  AI_PROVIDERS,
  activeProvider,
  type AiProviderId,
  type AiSettings,
} from '@genoffice/ai-provider/browser'
export interface AiModelPickerGroup {
  readonly id: AiProviderId
  readonly endpoint?: string | undefined
  readonly label: string
  readonly models: readonly string[]
}
export interface AiModelPickerSelection {
  readonly provider: AiProviderId
  readonly endpoint?: string | undefined
  readonly model: string
}
export function aiModelPickerGroups(
  settings: AiSettings,
  _loggedIn: boolean,
): AiModelPickerGroup[] {
  if (settings.accountProvider) return []
  return AI_PROVIDERS.flatMap((meta) => {
    const config = settings.providers?.[meta.id]
    if (!config?.apiKey?.trim() || !config.model?.trim()) return []
    if (meta.needsBaseUrl && !config.baseUrl?.trim()) return []
    return [
      { id: meta.id, label: meta.label, models: [...new Set([config.model, ...meta.models])] },
    ]
  })
}
export function aiModelPickerSelection(settings: AiSettings): AiModelPickerSelection {
  const provider = activeProvider(settings)
  return { provider, model: settings.providers?.[provider]?.model ?? '' }
}
export function withAiModelSelection(
  settings: AiSettings,
  pick: AiModelPickerSelection,
): AiSettings {
  return {
    ...settings,
    provider: pick.provider,
    providers: {
      ...settings.providers,
      [pick.provider]: { ...settings.providers?.[pick.provider], model: pick.model },
    },
  }
}
