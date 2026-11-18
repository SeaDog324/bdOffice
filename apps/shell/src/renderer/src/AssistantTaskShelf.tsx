import { useEffect, useState } from 'react'
import { officeTaskCopy, PortableOfficeResults, TaskQuestionReply } from '@genoffice/ui'
import type { PortableResultRecord } from '@genoffice/project-store'
import type {
  AssistantTaskControl,
  AssistantTaskFeed,
  AssistantTasksApi,
  AssistantTaskView,
} from '../../shared/assistant-task-api'

declare global {
  interface Window {
    aiOfficeTasks?: AssistantTasksApi
  }
}

export interface TaskActivity {
  running: number
  waiting: number
  attention: number
  total: number
  unread: number
}

export function AssistantTaskShelf({
  lang,
  embedded = false,
  visible = true,
  onActivityChange,
  onNavigate,
}: {
  lang: string
  embedded?: boolean
  visible?: boolean
  onActivityChange?(activity: TaskActivity): void
  onNavigate?(): void
}) {
  const api = window.aiOfficeTasks,
    copy = officeTaskCopy(lang)
  const [open, setOpen] = useState(false),
    [feed, setFeed] = useState<AssistantTaskFeed>({ tasks: [], notices: [], throughCursor: 0 })
  const expanded = embedded ? visible : open
  const [loaded, setLoaded] = useState(false),
    [feedError, setFeedError] = useState(false)
  const [working, setWorking] = useState(''),
    [reviewed, setReviewed] = useState(''),
    [error, setError] = useState('')
  const [results, setResults] = useState<{
    taskId: string
    records: PortableResultRecord[]
  } | null>(null)
  useEffect(() => {
    if (!api) return
    let alive = true,
      pending = false
    const poll = async () => {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      try {
        const value = await api.feed()
        if (alive) {
          setFeed(value)
          setLoaded(true)
          setFeedError(false)
        }
      } catch {
        if (alive) setFeedError(true)
      } finally {
        pending = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), expanded ? 700 : 2_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api, expanded])
  const needsAttention = (task: AssistantTaskView) =>
    task.state === 'waiting_user' ||
    task.state === 'interrupted' ||
    ['outcome_unknown', 'task_context_changed', 'task_unsaved_context_unavailable'].includes(
      task.reason ?? '',
    ) ||
    (task.state === 'failed' && feed.notices.some((notice) => notice.taskId === task.id))
  const running = feed.tasks.filter((task) =>
    ['preparing', 'running', 'verifying', 'pausing', 'cancelling'].includes(task.state),
  ).length
  const waiting = feed.tasks.filter((task) =>
    ['queued', 'waiting_resource', 'waiting_device'].includes(task.state),
  ).length
  const attention = feed.tasks.filter(needsAttention).length
  useEffect(() => {
    onActivityChange?.({
      running,
      waiting,
      attention,
      total: feed.tasks.length,
      unread: feed.notices.length,
    })
  }, [running, waiting, attention, feed.tasks.length, feed.notices.length, onActivityChange])
  const run = async (task: AssistantTaskView, action: AssistantTaskControl['action']) => {
    if (!api || working) return
    setWorking(task.id)
    setError('')
    try {
      const result = await api.control({
        taskId: task.id,
        requestId: crypto.randomUUID(),
        expectedRevision: task.revision,
        action,
        reviewed: action === 'reconcile' && reviewed === task.id,
      })
      setFeed((current) => ({
        ...current,
        tasks: current.tasks.map((value) => (value.id === result.id ? result : value)),
      }))
      setReviewed('')
    } catch (error) {
      setError(
        copy.reason(error instanceof Error ? error.message.split(/[: ]/).at(-1) : undefined) ??
          copy.unavailable,
      )
    } finally {
      setWorking('')
    }
  }
  if (!api) return embedded && visible ? <p role="alert">{copy.unavailable}</p> : null
  const actionable = feed.tasks.filter(
    (task) => !['completed', 'failed', 'cancelled'].includes(task.state),
  ).length
  const priority = (task: AssistantTaskView) =>
    needsAttention(task) ? 0 : !['completed', 'failed', 'cancelled'].includes(task.state) ? 1 : 2
  const content = expanded ? (
    <div>
      {feed.notices.length > 0 && (
        <div className="office-task-actions">
          <button
            type="button"
            disabled={!!working}
            onClick={() => {
              const ids = new Set(feed.notices.map((notice) => notice.id))
              setWorking('acknowledging')
              void Promise.all([...ids].map((id) => api.acknowledge(id)))
                .then(() =>
                  setFeed((current) => ({
                    ...current,
                    notices: current.notices.filter((notice) => !ids.has(notice.id)),
                  })),
                )
                .catch(() => setError(copy.unavailable))
                .finally(() => setWorking(''))
            }}
          >
            {lang.startsWith('zh') ? '全部标为已读' : 'Mark all as read'}
          </button>
        </div>
      )}
      {feedError && <p role="alert">{copy.unavailable}</p>}
      {!loaded && !feedError && (
        <p role="status">{lang.startsWith('zh') ? '正在读取任务…' : 'Loading tasks…'}</p>
      )}
      {loaded && !feedError && !feed.tasks.length && (
        <p>{lang.startsWith('zh') ? '还没有任务记录。' : 'No tasks yet.'}</p>
      )}
      {[...feed.tasks]
        .sort((a, b) => priority(a) - priority(b) || b.updatedAt - a.updatedAt)
        .slice(0, 30)
        .map((task) => (
          <div key={task.id} className="office-task-item" data-task-state={task.state}>
            <strong>{task.title}</strong> <small>{copy.status(task.state)}</small>
            {copy.reason(task.reason) && <p>{copy.reason(task.reason)}</p>}
            {task.confirmation && <p>{copy.status('waiting_user')}</p>}
            {task.confirmation?.kind === 'clarification' && (
              <TaskQuestionReply
                key={task.confirmation.id}
                question={task.confirmation.text}
                lang={lang}
                answer={async (answer) => {
                  const result = await api.answer({
                    taskId: task.id,
                    confirmationId: task.confirmation!.id,
                    requestId: crypto.randomUUID(),
                    expectedRevision: task.revision,
                    answer,
                  })
                  setFeed((current) => ({
                    ...current,
                    tasks: current.tasks.map((item) => (item.id === result.id ? result : item)),
                  }))
                }}
              />
            )}
            <div className="office-task-actions">
              <button
                type="button"
                onClick={() =>
                  void api
                    .openSession(task.id)
                    .then(() => onNavigate?.())
                    .catch(() => setError(copy.unavailable))
                }
              >
                {lang.startsWith('zh') ? '查看对话' : 'Open conversation'}
              </button>
              {task.evidenceIds.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    void api
                      .evidence(task.id)
                      .then((records) => setResults({ taskId: task.id, records }))
                      .catch(() => setError(copy.unavailable))
                  }
                >
                  {lang.startsWith('zh') ? '查看成果' : 'View results'}
                </button>
              )}
              {['queued', 'running', 'waiting_user', 'waiting_resource', 'preparing'].includes(
                task.state,
              ) && (
                <button type="button" disabled={!!working} onClick={() => void run(task, 'pause')}>
                  {copy.pause}
                </button>
              )}
              {['paused', 'interrupted', 'waiting_device'].includes(task.state) &&
                task.reason !== 'outcome_unknown' && (
                  <button
                    type="button"
                    disabled={!!working}
                    onClick={() => void run(task, 'resume')}
                  >
                    {copy.resume}
                  </button>
                )}
              {task.state === 'failed' && (
                <button type="button" disabled={!!working} onClick={() => void run(task, 'retry')}>
                  {copy.retry}
                </button>
              )}
              {!['completed', 'failed', 'cancelled'].includes(task.state) && (
                <button type="button" disabled={!!working} onClick={() => void run(task, 'cancel')}>
                  {copy.cancel}
                </button>
              )}
              {[
                'outcome_unknown',
                'task_context_changed',
                'task_unsaved_context_unavailable',
              ].includes(task.reason ?? '') && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewed === task.id}
                      onChange={(event) => setReviewed(event.target.checked ? task.id : '')}
                    />{' '}
                    {copy.reviewed}
                  </label>
                  <button
                    type="button"
                    disabled={!!working || reviewed !== task.id}
                    onClick={() => void run(task, 'reconcile')}
                  >
                    {copy.reconcile}
                  </button>
                </>
              )}
              {feed.notices.some((item) => item.taskId === task.id) && (
                <button
                  type="button"
                  onClick={() => {
                    void Promise.all(
                      feed.notices
                        .filter((item) => item.taskId === task.id)
                        .map((item) => api.acknowledge(item.id)),
                    )
                      .then(() =>
                        setFeed((current) => ({
                          ...current,
                          notices: current.notices.filter((item) => item.taskId !== task.id),
                        })),
                      )
                      .catch(() => setError(copy.unavailable))
                  }}
                >
                  {copy.acknowledge}
                </button>
              )}
            </div>
            {results?.taskId === task.id && (
              <PortableOfficeResults records={results.records} lang={lang} />
            )}
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
    </div>
  ) : null
  if (embedded)
    return (
      <section
        className="office-task-panel assistant-task-records"
        aria-label={lang.startsWith('zh') ? '所有对话的任务' : 'Tasks across conversations'}
      >
        {content}
      </section>
    )
  if (!feed.tasks.length && !open) return null
  return (
    <details
      className="office-task-panel assistant-task-shelf"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {copy.localTasks}
        {actionable ? ` · ${actionable}` : ''}
        {feed.notices.length ? ` · ${copy.notice}` : ''}
      </summary>
      {content}
    </details>
  )
}
