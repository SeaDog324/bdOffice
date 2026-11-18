import { useEffect, useState } from 'react'
import type { DefaultAppStatus } from '../../shared/home-api'
import type { TFunc } from './locale'

export function DefaultAppSetting({ t }: { t: TFunc }) {
  const [status, setStatus] = useState<DefaultAppStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    void window.aiOffice
      .getDefaultAppStatus?.()
      .then((value) => {
        if (live) setStatus(value)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (!status?.manualOnly) return
    const refresh = () => {
      void window.aiOffice
        .getDefaultAppStatus?.()
        .then(setStatus)
        .catch(() => {})
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [status?.manualOnly])
  if (!status || status.state === 'unsupported') return null
  const description = failed
    ? t('setDefaultAppFailed')
    : status.state === 'default'
      ? t('setDefaultAppIs')
      : status.state === 'other' && status.others.length
        ? t('setDefaultAppOther', { app: status.others.join(', ') })
        : t('setDefaultAppDesc')
  return (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <div className="set-field-label">{t('setDefaultApp')}</div>
          <div className="set-field-desc">{description}</div>
        </div>
      </div>
      <button
        className="set-btn"
        disabled={busy || status.state === 'default'}
        onClick={() => {
          setBusy(true)
          setFailed(false)
          void window.aiOffice
            .setDefaultApp()
            .then((next) => {
              setStatus(next)
              setFailed(!next.manualOnly && next.state !== 'default')
            })
            .catch(() => setFailed(true))
            .finally(() => setBusy(false))
        }}
      >
        {status.manualOnly ? t('setDefaultAppOpenSettings') : t('setDefaultAppSet')}
      </button>
    </div>
  )
}
