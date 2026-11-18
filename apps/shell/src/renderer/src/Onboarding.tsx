import { useEffect, useRef, useState } from 'react'
import type { OnboardingChoice } from '../../shared/connection-setup-api'
import appIcon from './assets/app-icon.svg'
import { useI18n } from './locale'
import { bigDogCopy } from './bigdog-copy'
import { BigDogWebsiteLink } from './BigDogWebsiteLink'
import { ConnectionSetup } from './ConnectionSetup'
import { onboardingCopy } from './onboarding-copy'
import './onboarding.css'

interface OnboardingProps {
  onDone: (choice: OnboardingChoice) => Promise<boolean>
  connectionOnly?: boolean
}

export function Onboarding({ onDone, connectionOnly = false }: OnboardingProps) {
  const { t, lang } = useI18n(),
    copy = onboardingCopy(lang)
  const [index, setIndex] = useState(connectionOnly ? 2 : 0)
  const [submitting, setSubmitting] = useState(false)
  const [commitBusy, setCommitBusy] = useState(false)
  const [error, setError] = useState(false)
  const busy = submitting || commitBusy
  const cardRef = useRef<HTMLDivElement>(null)
  const finishing = useRef(false)
  const titles = [copy.title, copy.workflowTitle, copy.connectTitle]
  const finish = async (choice: OnboardingChoice): Promise<boolean> => {
    if (finishing.current) return false
    finishing.current = true
    setSubmitting(true)
    setError(false)
    try {
      const saved = await onDone(choice)
      if (!saved) setError(true)
      return saved
    } catch {
      setError(true)
      return false
    } finally {
      finishing.current = false
      setSubmitting(false)
    }
  }
  const skip = () => {
    if (!busy) void finish('skipped')
  }
  const openSettings = () => {
    if (!busy)
      void finish('skipped').then((ok) => {
        if (ok) void window.aiOffice.openModelSettings()
      })
  }
  useEffect(() => {
    cardRef.current?.focus()
  }, [])
  useEffect(() => {
    const card = cardRef.current
    if (card && !card.contains(document.activeElement)) card.focus()
  }, [index])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        skip()
        return
      }
      const card = cardRef.current
      if (!card) return
      if (event.key === 'Tab') {
        const focusables = [
          ...card.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
          ),
        ].filter(
          (el) =>
            !el.closest('[inert], [hidden]') &&
            (!el.closest('details:not([open])') || el.tagName === 'SUMMARY'),
        )
        if (!focusables.length) {
          event.preventDefault()
          card.focus()
          return
        }
        const first = focusables[0],
          last = focusables.at(-1)!
        const active = document.activeElement
        if (!focusables.includes(active as HTMLElement)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        } else if (event.shiftKey && active === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
        return
      }
      const target = event.target
      if (
        busy ||
        (target instanceof HTMLElement &&
          target.closest('input, textarea, select, button, a, summary, [contenteditable="true"]'))
      )
        return
      if ((event.key === 'Enter' || event.key === 'ArrowRight') && index < 2) setIndex(index + 1)
      if (event.key === 'ArrowLeft') setIndex(Math.max(0, index - 1))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })
  return (
    <div className="onb-overlay" role="dialog" aria-modal="true" aria-label={titles[index]}>
      <div className="onb-card" ref={cardRef} tabIndex={-1}>
        <div className="onb-stage">
          <div className="onb-slide active">
            <img className="onb-art onb-art-logo" src={appIcon} alt="" />
            <h2 className="onb-title">{titles[index]}</h2>
            {index === 0 && (
              <>
                <p className="onb-subtitle">{copy.subtitle}</p>
                <ul className="onb-examples">
                  {copy.examples.map(([title, example]) => (
                    <li key={title}>
                      <strong>{title}</strong>
                      <span>{example}</span>
                    </li>
                  ))}
                </ul>
                <BigDogWebsiteLink className="onb-help-links" />
              </>
            )}
            {index === 1 && (
              <>
                <ol className="onb-workflow">
                  {copy.workflow.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <details className="onb-credits-note">
                  <summary>{bigDogCopy(lang).credits}</summary>
                  <p>{bigDogCopy(lang).attribution}</p>
                </details>
                <div className="onb-consent">
                  <span className="onb-consent-copy">
                    <span className="onb-consent-title">{t('setAnalytics')}</span>
                    <span className="onb-consent-desc">{t('setAnalyticsDesc')}</span>
                  </span>
                </div>
              </>
            )}
            {index === 2 && (
              <>
                <p className="onb-subtitle">{copy.connectSubtitle}</p>
                <ConnectionSetup
                  onDone={finish}
                  onCommitBusy={setCommitBusy}
                  onOpenSettings={openSettings}
                />
              </>
            )}
            {error && <p role="alert">{copy.finishFailed}</p>}
          </div>
        </div>
        <div className="onb-footer">
          <div className="onb-dots">
            {titles.map((title, i) => (
              <button
                key={title}
                disabled={busy}
                className={'onb-dot' + (i === index ? ' active' : '')}
                aria-label={t('onbStepAria', { n: i + 1, total: 3 })}
                aria-current={i === index}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
          <div className="onb-nav">
            <button className="onb-skip" disabled={busy} onClick={skip}>
              {t('onbSkip')}
            </button>
            {index > 0 && (
              <button className="onb-back" disabled={busy} onClick={() => setIndex(index - 1)}>
                {t('onbBack')}
              </button>
            )}
            {index < 2 && (
              <button className="onb-next" disabled={busy} onClick={() => setIndex(index + 1)}>
                {t('onbNext')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
