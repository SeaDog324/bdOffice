import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiProviderId } from '@genoffice/ai-provider'
import type { AiCatalogEntry } from '../../shared/home-api'
import type {
  ConnectionSummary,
  ConnectionSetupError,
  OnboardingChoice,
} from '../../shared/connection-setup-api'
import { useI18n } from './locale'
import { onboardingCopy } from './onboarding-copy'

interface Props {
  onDone(choice: OnboardingChoice): Promise<boolean>
  onCommitBusy(busy: boolean): void
  onOpenSettings(): void
}
export function ConnectionSetup({ onDone, onCommitBusy, onOpenSettings }: Props) {
  const { lang } = useI18n(),
    copy = onboardingCopy(lang)
  const [catalog] = useState<AiCatalogEntry[]>(() => window.aiOffice.getAiProviders?.() ?? [])
  const [connection, setConnection] = useState<ConnectionSummary | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [providerId, setProviderId] = useState<AiProviderId>('deepseek')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [editing, setEditing] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'testing' | 'saving'>('idle')
  const [verification, setVerification] = useState<string | null>(null)
  const [error, setError] = useState<ConnectionSetupError | null>(null)
  const [finishError, setFinishError] = useState(false)
  const generation = useRef(0),
    request = useRef<string | null>(null),
    alive = useRef(true)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const api = window.aiOffice.connectionSetup
  const meta = catalog.find((p) => p.id === providerId)

  const cancelRequest = useCallback(() => {
    generation.current++
    if (request.current) void api?.cancel(request.current).catch(() => {})
    request.current = null
  }, [api])
  const cancel = useCallback(() => {
    cancelRequest()
    setVerification(null)
    setPhase('idle')
  }, [cancelRequest])
  const load = useCallback(async () => {
    const epoch = ++generation.current
    setLoadError(false)
    try {
      const next = await api.inspect()
      if (alive.current && epoch === generation.current) setConnection(next)
    } catch {
      if (alive.current && epoch === generation.current) setLoadError(true)
    }
  }, [api])
  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
      cancelRequest()
    }
  }, [cancelRequest, load])
  useEffect(
    () =>
      window.aiOffice.onAiSettingsChanged?.(() => {
        if (phaseRef.current === 'saving') return
        cancel()
        setError('settings_changed')
        void load()
      }),
    [cancel, load],
  )

  const edit = (change: () => void) => {
    cancel()
    setError(null)
    setFinishError(false)
    change()
  }
  const test = async () => {
    if (!connection || phase !== 'idle') return
    cancel()
    const epoch = ++generation.current
    const requestId = crypto.randomUUID()
    request.current = requestId
    setPhase('testing')
    setError(null)
    setFinishError(false)
    try {
      const result = await api.test({
        requestId,
        expectedRevision: connection.revision,
        providerId,
        apiKey,
        modelId: modelId.trim() || meta?.defaultModel,
        baseUrl: baseUrl.trim(),
      })
      if (!alive.current || epoch !== generation.current) return
      if (result.ok) setVerification(result.verificationId)
      else {
        setError(result.errorCode)
        if (result.errorCode === 'settings_changed') void load()
      }
    } catch {
      if (alive.current && epoch === generation.current) setError('test_failed')
    } finally {
      if (alive.current && request.current === requestId) setPhase('idle')
    }
  }
  const save = async () => {
    if (!connection || !verification || phase !== 'idle') return
    setPhase('saving')
    phaseRef.current = 'saving'
    onCommitBusy(true)
    setError(null)
    try {
      const result = await api.commit({
        verificationId: verification,
        expectedRevision: connection.revision,
      })
      if (!alive.current) return
      if (!result.ok) {
        setError(result.errorCode)
        if (result.errorCode !== 'save_failed') setVerification(null)
        if (result.errorCode === 'settings_changed') void load()
        return
      }
      setApiKey('')
      setConnection(result.connection)
      setEditing(false)
      setVerification(null)
      request.current = null
      if (!(await onDone('connected')) && alive.current) setFinishError(true)
    } catch {
      if (alive.current) setError('save_failed')
    } finally {
      if (alive.current) {
        setPhase('idle')
        phaseRef.current = 'idle'
        onCommitBusy(false)
      }
    }
  }
  const existing = async () => {
    if (phase !== 'idle') return
    setPhase('saving')
    onCommitBusy(true)
    try {
      const latest = await api.inspect()
      if (!alive.current) return
      setConnection(latest)
      if (!latest.usable) {
        setError('settings_changed')
        return
      }
      if (!(await onDone('existing')) && alive.current) setFinishError(true)
    } catch {
      if (alive.current) setLoadError(true)
    } finally {
      if (alive.current) {
        setPhase('idle')
        onCommitBusy(false)
      }
    }
  }
  const busy = phase !== 'idle'
  const showForm = connection?.selection === 'api' && (!connection.usable || editing)
  return (
    <div className="connection-setup">
      {!connection && !loadError && <p role="status">{copy.loading}</p>}
      {loadError && (
        <div role="alert">
          {copy.inspectFailed}{' '}
          <button type="button" className="onb-back" onClick={() => void load()}>
            {copy.retry}
          </button>
        </div>
      )}
      {connection?.usable && !editing && (
        <div className="onb-connection-current">
          <p>{connection.selection === 'api' ? copy.configured : copy.existing}</p>
          <strong>
            {connection.selection === 'api'
              ? (catalog.find((p) => p.id === connection.providerId)?.label ??
                connection.providerId)
              : connection.selection}
            {connection.selection === 'api' ? ' · ' + connection.modelId : ''}
          </strong>
          <button
            type="button"
            className="onb-next"
            disabled={busy}
            onClick={() => void existing()}
          >
            {copy.useExisting}
          </button>
          {connection.selection === 'api' && (
            <button
              type="button"
              className="onb-link"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              {copy.change}
            </button>
          )}
        </div>
      )}
      {connection && connection.selection !== 'api' && <p>{copy.account}</p>}
      {showForm && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void (verification ? save() : test())
          }}
        >
          <label htmlFor="onb-provider">{copy.provider}</label>
          <select
            id="onb-provider"
            value={providerId}
            disabled={busy}
            onChange={(e) =>
              edit(() => {
                setProviderId(e.target.value as AiProviderId)
                setModelId('')
                setBaseUrl('')
                setApiKey('')
              })
            }
          >
            {[...catalog]
              .sort((a, b) => Number(b.id === 'deepseek') - Number(a.id === 'deepseek'))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
          </select>
          {providerId === 'deepseek' && (
            <div className="onb-help-links">
              <a
                href="https://platform.deepseek.com/"
                onClick={(e) => {
                  e.preventDefault()
                  void api.openHelp('deepseek-platform').catch(() => setLoadError(true))
                }}
              >
                {copy.platform}
              </a>
              <a
                href="https://api-docs.deepseek.com/"
                onClick={(e) => {
                  e.preventDefault()
                  void api.openHelp('deepseek-docs').catch(() => setLoadError(true))
                }}
              >
                {copy.apiDocs}
              </a>
            </div>
          )}
          <label htmlFor="onb-api-key">{copy.key}</label>
          <input
            id="onb-api-key"
            type="password"
            value={apiKey}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder={meta?.keyPlaceholder ?? 'sk-…'}
            onChange={(e) => edit(() => setApiKey(e.target.value))}
          />
          <details className="onb-advanced" open={meta?.needsBaseUrl || undefined}>
            <summary>{copy.advanced}</summary>
            <label htmlFor="onb-model">{copy.model}</label>
            <input
              id="onb-model"
              value={modelId}
              disabled={busy}
              placeholder={meta?.defaultModel}
              onChange={(e) => edit(() => setModelId(e.target.value))}
            />
            <label htmlFor="onb-endpoint">{copy.endpoint}</label>
            <input
              id="onb-endpoint"
              value={baseUrl}
              disabled={busy}
              placeholder={meta?.defaultBaseUrl || 'https://…/v1'}
              onChange={(e) => edit(() => setBaseUrl(e.target.value))}
            />
          </details>
          <p className="onb-connection-note">{copy.note}</p>
          {verification && (
            <p className="onb-connection-success" role="status">
              {copy.tested}
            </p>
          )}
          <div className="onb-connection-actions">
            <button
              type="submit"
              className="onb-next"
              disabled={busy || (!apiKey.trim() && !(providerId === 'custom' && baseUrl.trim()))}
            >
              {phase === 'testing'
                ? copy.testing
                : phase === 'saving'
                  ? copy.saving
                  : verification
                    ? copy.save
                    : copy.test}
            </button>
            {phase === 'testing' && (
              <button type="button" className="onb-back" onClick={cancel}>
                {copy.cancelTest}
              </button>
            )}
          </div>
        </form>
      )}
      {error && <p role="alert">{copy.errors[error]}</p>}
      {finishError && <p role="alert">{copy.finishFailed}</p>}
      <button
        type="button"
        className="onb-link"
        disabled={phase === 'saving'}
        onClick={onOpenSettings}
      >
        {copy.settings}
      </button>
      <p className="onb-connection-note">{copy.privacy}</p>
    </div>
  )
}
