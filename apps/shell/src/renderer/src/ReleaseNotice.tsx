import { useEffect, useState } from 'react'
import type { BigDogReleaseStatus } from '../../shared/bigdog-release'
import { bigDogCopy } from './bigdog-copy'
import { useI18n } from './locale'
import './release-notice.css'

/** Lives in the tab strip, above native editor views. No dialog or focus steal. */
export function ReleaseNotice() {
  const { lang } = useI18n()
  const copy = bigDogCopy(lang)
  const [status, setStatus] = useState<BigDogReleaseStatus | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let alive = true
    let received = false
    const unsubscribe = window.aiOffice.onBigDogReleaseChanged?.((next) => {
      received = true
      setStatus(next)
      setError(false)
    })
    void window.aiOffice
      .getBigDogReleaseStatus?.()
      .then((next) => {
        if (alive && !received) setStatus(next)
      })
      .catch(() => {})
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [])
  if (status?.phase !== 'available') return null
  return (
    <div className="release-notice" role="status" aria-live="polite">
      <button
        className="release-notice-link"
        title={copy.available(status.version)}
        onClick={() => {
          setError(false)
          void window.aiOffice.openBigDogReleases(status.version).catch(() => setError(true))
        }}
      >
        <span aria-hidden="true">↑</span> {copy.newVersion} {status.version}
      </button>
      <button
        className="release-notice-dismiss"
        aria-label={copy.dismissUpdate}
        title={copy.dismissUpdate}
        onClick={() => {
          void window.aiOffice.dismissBigDogRelease(status.version).catch(() => setError(true))
        }}
      >
        ×
      </button>
      {error && (
        <span className="release-notice-error" role="alert" title={copy.checkFailed}>
          {copy.checkFailed}
        </span>
      )}
    </div>
  )
}
