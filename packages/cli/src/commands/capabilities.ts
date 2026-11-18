import {
  activeMediaProvider,
  activeSearchProvider,
  resolveImageSettings,
  imageGenerationAvailable,
  mediaAnalysisAvailable,
} from '@genoffice/ai-provider'
import { readAiSettingsFile } from '@genoffice/ai-search'
import { aiSettingsPath, prepareCloud } from '../cloud'
import type { CommandDef } from '../registry'
import { appLaunch } from '../resources'

/**
 * What the cloud commands can do on this machine, decided from BigDogOffice's
 * own settings without a network call: a Genspark login with cloud tools on,
 * a BYOK key, or explicitly selected free Parallel search. Unkeyed fallbacks in the
 * default chain (free Parallel MCP, DuckDuckGo) do not count as configured. Agents
 * check this once before planning work that needs photos or web facts.
 */
export const capabilitiesCommand: CommandDef = {
  name: 'capabilities',
  summary:
    'Report which cloud features (search, image search, image generation, media analysis) are configured in BigDogOffice, and whether the app is installed.',
  usage: 'capabilities',
  async run(_args, ctx) {
    await prepareCloud(ctx.env)
    const settings = readAiSettingsFile(aiSettingsPath(ctx.env))
    const gsk = false
    const searchProvider = activeSearchProvider(settings)
    const gskSearch = false
    const customSearch = searchProvider !== 'genspark'
    const search = gskSearch || customSearch
    const keyedImageSearch = searchProvider === 'serper'
    const imageSearch = gskSearch || keyedImageSearch
    const imageGeneration = imageGenerationAvailable(settings, false)
    const mediaAnalysis = mediaAnalysisAvailable(settings, false)
    const via = (byok: string | null | undefined) => (byok ? byok : gsk ? 'genspark' : null)
    const detail = {
      search: {
        available: search,
        via: customSearch ? searchProvider : gskSearch ? 'genspark' : null,
      },
      image_search: {
        available: imageSearch,
        via: keyedImageSearch ? searchProvider : gskSearch ? 'genspark' : null,
      },
      image_generation: {
        available: imageGeneration,
        via: imageGeneration
          ? resolveImageSettings(settings.imageGeneration, settings).provider
          : null,
      },
      media_analysis: {
        available: mediaAnalysis,
        via: mediaAnalysis ? via(activeMediaProvider(settings, 'analysis')) : null,
      },
      app: { available: appLaunch(ctx.env) !== null },
      settings_path: aiSettingsPath(ctx.env),
    }
    const on = Object.entries(detail)
      .filter(([k, v]) => k !== 'settings_path' && (v as { available: boolean }).available)
      .map(([k]) => k)
    return {
      summary: on.length
        ? `configured: ${on.join(', ')}`
        : 'no cloud feature configured; the app is not installed',
      detail,
    }
  },
}
