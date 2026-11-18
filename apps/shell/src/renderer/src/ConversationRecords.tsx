import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AssistantTaskShelf, type TaskActivity } from './AssistantTaskShelf'
import { RunEvidenceHistory } from './RunReviewCard'

/** Optional records stay out of the transcript; only current task activity remains in the toolbar. */
export function ConversationRecords({
  lang,
  sessionId,
  revision,
  undoingRunId,
  onUndo,
  onOpen,
}: {
  lang: string
  sessionId: string | null
  revision: string
  undoingRunId: string | null
  onUndo(runId: string): void
  onOpen(path: string, artifactId?: string): void
}) {
  const zh = /^zh/i.test(lang),
    titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState<'tasks' | 'results'>('tasks')
  const [activity, setActivity] = useState<TaskActivity>({
    running: 0,
    waiting: 0,
    attention: 0,
    total: 0,
    unread: 0,
  })
  const close = useCallback(() => {
    dialog.current?.close()
    setOpen(false)
  }, [])
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (open && !node.open) node.showModal()
    else if (!open && node.open) node.close()
  }, [open])
  const status = activity.attention
    ? `${activity.attention} ${zh ? '待处理' : 'need attention'}`
    : activity.running
      ? `${activity.running} ${zh ? '进行中' : 'running'}`
      : activity.waiting
        ? `${activity.waiting} ${zh ? '等待中' : 'waiting'}`
        : activity.unread
          ? `${activity.unread} ${zh ? '条更新' : 'updates'}`
          : ''
  return (
    <>
      <button
        type="button"
        className="workspace-chat-records-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
        </svg>
        <span>{zh ? '工作记录' : 'Work records'}</span>
        {status && <small className={activity.attention ? 'needs-attention' : ''}>{status}</small>}
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="work-records-dialog"
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault()
            close()
          }}
          onClose={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.stopPropagation()
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) close()
          }}
        >
          <div className="work-records-content">
            <header>
              <h2 id={titleId}>{zh ? '工作记录' : 'Work records'}</h2>
              <button
                type="button"
                aria-label={zh ? '关闭工作记录' : 'Close work records'}
                onClick={close}
              >
                ×
              </button>
            </header>
            <nav aria-label={zh ? '记录类型' : 'Record type'}>
              <button type="button" aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>
                {zh ? '任务' : 'Tasks'}
                {activity.total ? ` (${activity.total})` : ''}
              </button>
              <button
                type="button"
                aria-pressed={tab === 'results'}
                disabled={!sessionId}
                onClick={() => setTab('results')}
              >
                {zh ? '本会话成果' : 'Conversation results'}
              </button>
            </nav>
            <div className="work-records-body">
              <div hidden={tab !== 'tasks'}>
                <p className="work-records-scope">
                  {zh
                    ? '所有对话的任务，待处理事项优先显示。'
                    : 'Tasks across conversations, with items needing attention first.'}
                </p>
                <AssistantTaskShelf
                  lang={lang}
                  embedded
                  visible={open && tab === 'tasks'}
                  onActivityChange={setActivity}
                  onNavigate={close}
                />
              </div>
              {sessionId && (
                <div hidden={tab !== 'results'}>
                  <RunEvidenceHistory
                    key={sessionId}
                    sessionId={sessionId}
                    lang={lang}
                    expanded={open && tab === 'results'}
                    revision={revision}
                    undoingRunId={undoingRunId}
                    onUndo={onUndo}
                    onOpen={(path, artifactId) => {
                      close()
                      onOpen(path, artifactId)
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  )
}
