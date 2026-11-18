import type { AiModelCatalog, AiProviderConfig } from './types'

export const MODEL_CATALOG_TTL_MS = 15 * 60 * 1000
export const MAX_CATALOG_MODELS = 2000

export function isModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/u.test(value) &&
    !value.includes('://')
  )
}

export function normalizeModelIds(value: unknown, limit = MAX_CATALOG_MODELS): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(isModelId))].slice(0, limit)
}

/** Do not accept URL-embedded credentials or query secrets in a persisted catalog. */
export function modelCatalogBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined
    return url.toString().replace(/\/+$/u, '')
  } catch {
    return undefined
  }
}

export function normalizeModelCatalog(value: unknown): AiModelCatalog | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const baseUrl = typeof raw.baseUrl === 'string' && modelCatalogBaseUrl(raw.baseUrl)
  const models = normalizeModelIds(raw.models)
  if (
    !baseUrl ||
    !models.length ||
    typeof raw.fetchedAt !== 'number' ||
    !Number.isFinite(raw.fetchedAt) ||
    raw.fetchedAt <= 0
  )
    return undefined
  return { baseUrl, models, fetchedAt: raw.fetchedAt }
}

export function usableModelCatalog(
  config: AiProviderConfig,
  defaultBaseUrl: string,
): AiModelCatalog | undefined {
  const catalog = normalizeModelCatalog(config.modelCatalog)
  return catalog?.baseUrl === modelCatalogBaseUrl(config.baseUrl?.trim() || defaultBaseUrl)
    ? catalog
    : undefined
}

/** Upstream replaces the old upstream list, but never the user's current/manual IDs. */
export function chatModelOptions(
  config: AiProviderConfig,
  meta: { models: string[]; defaultBaseUrl: string },
): string[] {
  const catalog = usableModelCatalog(config, meta.defaultBaseUrl)
  return normalizeModelIds(
    [
      config.model,
      ...normalizeModelIds(config.customModels, 100),
      ...(catalog ? catalog.models : meta.models),
    ],
    MAX_CATALOG_MODELS + 101,
  )
}
