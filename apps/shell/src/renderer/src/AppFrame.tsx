import { useEffect, useState } from 'react'
import { Home } from './Home'
import { Onboarding } from './Onboarding'
import { TabBar } from './TabBar'
import { OPEN_ONBOARDING } from './onboarding-copy'
import type { OnboardingChoice } from '../../shared/connection-setup-api'
interface AppFrameProps {
  /** resolved before first paint (main.tsx) so home never flashes under the overlay */
  initialOnboardingSeen: boolean
}

export function AppFrame({ initialOnboardingSeen }: AppFrameProps) {
  const [homeActive, setHomeActive] = useState(true)
  const [showOnboarding, setShowOnboarding] = useState(!initialOnboardingSeen)
  const [connectionOnly, setConnectionOnly] = useState(false)
  useEffect(() => {
    const open = (event: Event) => {
      setConnectionOnly(
        (event as CustomEvent<{ connectionOnly?: boolean }>).detail?.connectionOnly === true,
      )
      setShowOnboarding(true)
    }
    window.addEventListener(OPEN_ONBOARDING, open)
    return () => window.removeEventListener(OPEN_ONBOARDING, open)
  }, [])
  useEffect(() => {
    const applyTabs = (tabs: Awaited<ReturnType<typeof window.aiOfficeTabs.list>>) => {
      const active = tabs.find((tab) => tab.active)
      setHomeActive(!active || active.kind === 'home')
    }
    void window.aiOfficeTabs.list().then(applyTabs)
    return window.aiOfficeTabs.onChanged(applyTabs)
  }, [])

  const openAi = () => {
    void window.aiOfficeWorkspaceAgent?.openHome()
  }

  const finishOnboarding = async (choice: OnboardingChoice): Promise<boolean> => {
    try {
      const persisted = await window.aiOffice.setOnboardingSeen(choice)
      if (!persisted) return false
      setShowOnboarding(false)
      return true
    } catch {
      return false
    }
  }

  return (
    <div className="app-frame">
      <TabBar onToggleChat={openAi} />
      {/* docs/sheets tabs render as WebContentsView children of this window, positioned
       * by the main process to cover this area — only Home paints its own content here. */}
      <div
        className="app-frame-content"
        style={{
          visibility: homeActive ? 'visible' : 'hidden',
          containerType: 'inline-size',
        }}
      >
        <Home />
      </div>
      {showOnboarding && homeActive && (
        <Onboarding connectionOnly={connectionOnly} onDone={finishOnboarding} />
      )}
    </div>
  )
}
