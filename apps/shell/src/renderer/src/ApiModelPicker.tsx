import { useEffect, useRef, useState } from 'react'
import { Dropdown } from '@genoffice/ui'
import {
  MODEL_CATALOG_TTL_MS,
  chatModelOptions,
  isModelId,
  modelCatalogBaseUrl,
  normalizeModelIds,
  usableModelCatalog,
} from '@genoffice/ai-provider'
import type { AiModelListErrorCode, AiProviderConfig, AiProviderId } from '@genoffice/ai-provider'
import type { AiCatalogEntry } from '../../shared/home-api'
import { aiModelCopy } from './ai-model-copy'

export function ApiModelPicker({
  provider,
  config,
  meta,
  label,
  lang,
  settledRevision,
  onChange,
}: {
  provider: AiProviderId
  config: AiProviderConfig
  meta: AiCatalogEntry
  label: string
  lang: string
  settledRevision: number
  onChange(patch: Partial<AiProviderConfig>, userEdit?: boolean): void
}) {
  const copy = aiModelCopy(lang)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<AiModelListErrorCode | null>(null)
  const latest = useRef({ config, onChange })
  const cancelCurrent = useRef<(() => void) | null>(null)
  const lastManual = useRef(0)
  const editedModel = useRef(false)
  const apiKey = config.apiKey
  const baseUrl = config.baseUrl ?? ''
  const defaultBaseUrl = meta.defaultBaseUrl
  useEffect(() => {
    latest.current = { config, onChange }
  }, [config, onChange])

  useEffect(() => {
    let current = true
    let requestId: string | undefined
    const cancel = () => {
      current = false
      if (requestId) void window.aiOffice.cancelAiModelList?.(requestId).catch(() => {})
    }
    cancelCurrent.current = () => {
      cancel()
      setLoading(false)
      setError('cancelled')
    }
    setLoading(false)
    setError(null)
    const manual = refresh !== lastManual.current
    const cache = usableModelCatalog(latest.current.config, defaultBaseUrl)
    const age = cache ? Date.now() - cache.fetchedAt : Infinity
    const ready =
      !!modelCatalogBaseUrl(baseUrl.trim() || defaultBaseUrl) &&
      (!!apiKey.trim() || provider === 'custom')
    if (
      !window.aiOffice.listAiModels ||
      !ready ||
      (!manual && age >= 0 && age < MODEL_CATALOG_TTL_MS)
    ) {
      return cancel
    }
    const timer = setTimeout(
      () => {
        // Never send a saved key to a half-entered hostname while the field is still being edited.
        if (!manual && ['set-ai-key', 'set-ai-base-url'].includes(document.activeElement?.id ?? ''))
          return
        lastManual.current = refresh
        requestId = crypto.randomUUID()
        setLoading(true)
        void window.aiOffice
          .listAiModels({ requestId, provider, config: { apiKey, baseUrl } })
          .then((result) => {
            const activeConfig = latest.current.config
            if (
              !current ||
              activeConfig.apiKey !== apiKey ||
              (activeConfig.baseUrl ?? '') !== baseUrl
            )
              return
            if (result.ok) latest.current.onChange({ modelCatalog: result.catalog }, manual)
            else setError(result.errorCode)
          })
          .catch(() => {
            if (current) setError('network')
          })
          .finally(() => {
            if (current) setLoading(false)
          })
      },
      manual ? 0 : 900,
    )
    return () => {
      clearTimeout(timer)
      cancel()
      cancelCurrent.current = null
    }
  }, [provider, apiKey, baseUrl, defaultBaseUrl, refresh, settledRevision])

  const cache = usableModelCatalog(config, defaultBaseUrl)
  const models = chatModelOptions(config, meta)
  const ready =
    !!modelCatalogBaseUrl(baseUrl.trim() || defaultBaseUrl) &&
    (!!apiKey.trim() || provider === 'custom')
  const needsResponses =
    modelCatalogBaseUrl(baseUrl.trim() || defaultBaseUrl) === 'https://api.openai.com/v1' &&
    /^gpt-6-astra(?:$|-)/iu.test(config.model)
  return (
    <div className="set-model-section">
      <div className="set-field">
        <div className="set-field-text set-field-stack">
          <label className="set-field-label" htmlFor="set-ai-model">
            {label}
          </label>
          <div className="set-field-desc">{copy.modelHint}</div>
        </div>
        <div className="set-model-input">
          <input
            id="set-ai-model"
            className="set-input"
            type="text"
            value={config.model}
            placeholder="model-id"
            maxLength={256}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              editedModel.current = true
              onChange({ model: event.target.value.trim() })
            }}
            onBlur={() => {
              if (
                editedModel.current &&
                isModelId(config.model) &&
                !meta.models.includes(config.model) &&
                !cache?.models.includes(config.model) &&
                !config.customModels?.includes(config.model)
              ) {
                onChange({
                  customModels: normalizeModelIds(
                    [config.model, ...(config.customModels ?? [])],
                    100,
                  ),
                })
              }
              editedModel.current = false
            }}
          />
          <Dropdown
            className="set-dd set-model-dropdown"
            value={config.model}
            options={models.map((model) => ({ value: model, label: model }))}
            ariaLabel={copy.chooseModel}
            disabled={!models.length}
            onPick={(model) => onChange({ model })}
          />
        </div>
      </div>
      <div className="set-model-discovery">
        <div className="set-field-desc" role="status" aria-live="polite">
          {loading ? (
            copy.fetchingModels
          ) : error ? (
            <span className="set-runtime-error">{copy.modelErrors[error]}</span>
          ) : cache ? (
            `${copy.upstreamModels} · ${cache.models.length}`
          ) : (
            copy.presetModels
          )}
        </div>
        <button
          type="button"
          className="set-btn"
          disabled={!loading && !ready}
          onClick={() => (loading ? cancelCurrent.current?.() : setRefresh((value) => value + 1))}
        >
          {loading ? copy.cancelModels : cache ? copy.refreshModels : copy.fetchModels}
        </button>
      </div>
      <p className="set-field-desc set-model-hint">{cache ? copy.modelsSaved : copy.autoModels}</p>
      {cache && config.model && !cache.models.includes(config.model) && (
        <p className="set-field-desc set-model-hint">{copy.modelNotListed}</p>
      )}
      {needsResponses && <p className="set-field-desc set-model-hint">{copy.responsesRequired}</p>}
    </div>
  )
}
