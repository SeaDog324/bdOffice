import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentApprovalMode } from '../../shared/workspace-agent-api'
import type { WorkspaceChatCopy } from './workspace-chat-strings'

export function AgentApprovalControl({
  mode,
  ready,
  saving,
  onChange,
  copy,
  loadError,
  onRetry,
  actions,
}: {
  mode: AgentApprovalMode
  ready: boolean
  saving: boolean
  onChange: (mode: AgentApprovalMode) => Promise<void>
  copy: WorkspaceChatCopy
  loadError?: string
  onRetry?: () => void
  actions?: ReactNode
}) {
  const busy = useRef(false)
  const [saveError, setSaveError] = useState('')
  const apply = async (next: AgentApprovalMode) => {
    if (busy.current || saving || !ready || next === mode) return
    busy.current = true
    setSaveError('')
    try {
      await onChange(next)
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : copy.agentFailed)
    } finally {
      busy.current = false
    }
  }

  return (
    <section className="workspace-chat-approval" aria-label={copy.approvalMode} aria-busy={saving}>
      <div className="workspace-chat-approval-row">
        <span className="workspace-chat-approval-label">{copy.approvalMode}</span>
        <div
          className="workspace-chat-approval-options"
          role="group"
          aria-label={copy.approvalMode}
        >
          <button
            type="button"
            aria-pressed={ready && mode === 'per-action'}
            disabled={!ready || saving}
            onClick={() => void apply('per-action')}
          >
            {copy.approvalPerAction}
          </button>
          <button
            type="button"
            aria-pressed={ready && mode === 'auto'}
            disabled={!ready || saving}
            onClick={() => void apply('auto')}
          >
            {copy.approvalAuto}
          </button>
        </div>
        {actions}
      </div>
      {(loadError || saveError) && (
        <div className="workspace-chat-approval-notice" role="alert">
          {loadError || saveError}
          {loadError && onRetry && (
            <button type="button" className="workspace-chat-small-btn" onClick={onRetry}>
              {copy.retry}
            </button>
          )}
        </div>
      )}
      <span className="workspace-chat-approval-sr" role="status">
        {saving
          ? copy.saving
          : !ready
            ? copy.approvalLoading
            : mode === 'auto'
              ? copy.approvalAutoApplied
              : copy.approvalPerActionApplied}
      </span>
    </section>
  )
}
