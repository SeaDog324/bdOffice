import { useState, type MouseEvent } from 'react'
import { BIGDOG_WEBSITE_URL } from '../../shared/bigdog-release'
import { bigDogCopy } from './bigdog-copy'
import { useI18n } from './locale'

export function BigDogWebsiteLink({
  className,
  showAddress = false,
}: {
  className: string
  showAddress?: boolean
}) {
  const { lang } = useI18n()
  const copy = bigDogCopy(lang)
  const [openFailed, setOpenFailed] = useState(false)

  function openWebsite(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    setOpenFailed(false)
    void window.aiOffice.openBigDogWebsite().catch(() => setOpenFailed(true))
  }

  return (
    <div className={className}>
      <a
        href={BIGDOG_WEBSITE_URL}
        title={BIGDOG_WEBSITE_URL}
        onClick={openWebsite}
        onAuxClick={(event) => {
          if (event.button === 1) openWebsite(event)
        }}
      >
        {showAddress ? new URL(BIGDOG_WEBSITE_URL).host : copy.website}
      </a>
      {openFailed && <p role="alert">{copy.websiteOpenFailed}</p>}
    </div>
  )
}
