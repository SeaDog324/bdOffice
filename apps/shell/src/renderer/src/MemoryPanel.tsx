import { useCallback, useEffect, useRef, useState } from 'react'
import type { ManagedSessionMeta, SessionView } from '@genoffice/project-store'
import { WorkspaceMarkdown } from './WorkspaceMarkdown'
import { OutcomeMemoryList } from './OutcomeMemoryList'
import { DogIllustration } from './DogIllustration'
import { stripMemoryContextEcho } from '@genoffice/project-store/browser'
import { SessionMutationDraft, sessionMutationError } from './session-mutations'
import { FileBadge } from './file-badge'
import chatIcon from './assets/chat-icon.svg'
import './managed-sessions.css'
import './memory-panel.css'

export function readableMemory(view: SessionView, zh: boolean): string {
  if (view.session.summary.mode === 'manual') return view.markdown
  if (!view.session.context.messages.length && !view.session.context.pendingInput) return ''
  return readableGeneratedMemory(view.markdown, zh)
}
function readableGeneratedMemory(markdown: string, zh: boolean): string {
  // The generated note also stores recovery metadata, which belongs in advanced management.
  return stripMemoryContextEcho(markdown)
    .split('## Budget')[0]!
    .split(/(?=^## )/m)
    .slice(1)
    .filter((section) => !section.startsWith('## Earlier context'))
    .join('')
    .replace('## Recent requests', zh ? '你提出的需求' : 'Your requests')
    .replace('## Unfinished request', zh ? '尚未完成的需求' : 'Unfinished request')
    .replace(
      '## Reported outcomes',
      zh ? '对话中记录的答复' : 'Answers recorded in the conversation',
    )
    .trim()
}

export function MemoryPanel({
  lang,
  currentSessionId,
  onClose,
  onAdvanced,
}: {
  lang: string
  currentSessionId?: string | null
  onClose(): void
  onAdvanced(): void
}) {
  const api = window.managedSessions!
  const zh = /^zh/i.test(lang)
  const t = (cn: string, en: string) => (zh ? cn : en)
  const [sessions, setSessions] = useState<ManagedSessionMeta[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(currentSessionId ?? null)
  const [view, setView] = useState<SessionView | null>(null)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const [searching, setSearching] = useState(false)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mutation = useRef(new SessionMutationDraft())
  const [notice, setNotice] = useState('')
  const selectedRevision = sessions.find((item) => item.id === selected)?.revision
  const request = useRef(0)
  const lock = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const detail = useRef<HTMLDivElement>(null)
  const cancelRefresh = useCallback(() => {
    request.current++
  }, [])
  const refresh = useCallback(async () => {
    const sequence = ++request.current
    const all = await api.list()
    if (sequence !== request.current) return
    const visible = all.filter((m) => m.purpose !== 'maintenance')
    setSessions(visible)
    setLoaded(true)
    setSelected((current) =>
      visible.some((item) => item.id === current) ? current : (visible[0]?.id ?? null),
    )
  }, [api])
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const update = () => {
      void refresh().catch((e) => setError(String(e)))
    }
    update()
    const off = api.onChanged(update)
    return () => {
      off()
      cancelRefresh()
    }
  }, [api, refresh, cancelRefresh])
  useEffect(() => {
    let alive = true
    if (!query.trim()) {
      setMatches(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      void api
        .list({ query: query.trim() })
        .then((rows) => {
          if (alive) setMatches(new Set(rows.map((row) => row.id)))
        })
        .catch((reason) => {
          if (alive) setError(String(reason))
        })
        .finally(() => {
          if (alive) setSearching(false)
        })
    }, 180)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, query, sessions])
  useEffect(() => {
    setView(null)
    setEditing(false)
    setNotice('')
    if (detail.current) detail.current.scrollTop = 0
  }, [selected])
  useEffect(() => {
    if (editing) return
    let alive = true
    if (selected)
      void api
        .get(selected)
        .then((next) => {
          if (alive) setView(next)
        })
        .catch((e) => {
          if (alive) setError(String(e))
        })
    return () => {
      alive = false
    }
  }, [api, selected, selectedRevision, editing])
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      await refresh()
    } catch (e) {
      setError(sessionMutationError(e, zh))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const visible = query.trim() && matches ? sessions.filter((m) => matches.has(m.id)) : sessions
  const meta = visible.find((item) => item.id === selected)
  const currentView = view?.session.meta.id === meta?.id ? view : null
  const memory = currentView ? readableMemory(currentView, zh) : ''
  const memoryPreview = memory
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '').trim())
    .filter(Boolean)
    .join(' ')
  const title = (m: ManagedSessionMeta) =>
    /^(New session|New conversation|新会话|新对话)$/i.test(m.title)
      ? t('未命名对话', 'Untitled conversation')
      : m.title
  return (
    <section
      className="managed-sessions memory-panel"
      aria-label={t('记忆管理', 'Memory')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || editing || busy) return
        event.stopPropagation()
        onClose()
      }}
    >
      <header className="memory-panel-head">
        <h2 ref={heading} tabIndex={-1}>
          {t('大狗记住了什么', 'What BigDog remembers')}
        </h2>
        <div className="memory-panel-head-actions">
          <button type="button" disabled={editing || busy} onClick={onAdvanced}>
            {t('高级管理', 'Advanced management')}
          </button>
          <button
            type="button"
            className="memory-panel-close"
            onClick={onClose}
            aria-label={t('关闭记忆', 'Close memory')}
          >
            ×
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="managed-session-error">
          {error}
        </p>
      )}
      {notice && (
        <p className="memory-notice" role="status">
          {notice}
        </p>
      )}
      <div className="memory-browser">
        <div className="memory-browser-sidebar">
          <input
            type="search"
            aria-label={t('搜索记忆', 'Search memory')}
            placeholder={t('搜索记忆', 'Search memory')}
            value={query}
            disabled={busy || editing}
            onChange={(event) => {
              setError('')
              setQuery(event.currentTarget.value)
            }}
          />
          <nav
            className="memory-results"
            aria-label={t('记忆来源', 'Memory sources')}
            aria-busy={!loaded || searching}
          >
            {!error && (!loaded || searching) && (
              <p className="memory-list-status" role="status">
                {searching ? t('正在搜索…', 'Searching…') : t('正在读取记忆…', 'Loading memories…')}
              </p>
            )}
            {!error && loaded && !visible.length && !searching && (
              <p className="memory-list-status">
                {query.trim()
                  ? t('没有匹配的记忆', 'No matching memories')
                  : t('还没有记忆', 'No memories yet')}
              </p>
            )}
            {visible.map((item) => {
              const source = item.source?.filePath?.split(/[\\/]/).pop()
              const rowTitle = title(item)
              const sourceLabel = source
                ? source === rowTitle
                  ? t('文件对话', 'File conversation')
                  : source
                : item.id === currentSessionId
                  ? t('当前对话', 'Current conversation')
                  : t('对话', 'Conversation')
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={busy || editing}
                  aria-current={item.id === selected ? 'true' : undefined}
                  title={rowTitle}
                  onClick={() => setSelected(item.id)}
                >
                  {source ? (
                    <FileBadge ext={source.split('.').pop()?.toLowerCase() ?? ''} size={25} />
                  ) : (
                    <img src={chatIcon} alt="" width={25} height={25} />
                  )}
                  <span className="memory-result-copy">
                    <strong>{rowTitle}</strong>
                    <small>
                      {sourceLabel}
                      {item.memoryDisabled && t(' · 已暂停引用', ' · Paused')}
                    </small>
                  </span>
                </button>
              )
            })}
          </nav>
        </div>
        <div className="memory-detail" ref={detail} aria-busy={busy}>
          {meta && currentView ? (
            <>
              <div className="memory-detail-head">
                <h3 title={title(meta)}>{title(meta)}</h3>
                <div className="memory-detail-meta">
                  <small title={meta.source?.filePath}>
                    {meta.source?.filePath?.split(/[\\/]/).pop() ??
                      t('来自 AI 大狗对话', 'From an AI BigDog conversation')}
                  </small>
                  <span className="memory-use-state" data-enabled={!meta.memoryDisabled}>
                    {meta.memoryDisabled
                      ? t('已暂停引用', 'Use paused')
                      : t('可自动引用', 'Available for automatic use')}
                  </span>
                </div>
              </div>
              {editing ? (
                <>
                  <label className="memory-editor">
                    {t('修改记忆', 'Edit memory')}
                    <textarea
                      aria-label={t('修改记忆内容', 'Edit memory content')}
                      autoFocus
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </label>
                  <div className="managed-session-actions">
                    <button
                      type="button"
                      className="memory-save-button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await mutation.current.apply(api, currentView, {
                            kind: 'update_memory',
                            markdown: text,
                          })
                          setView(await api.get(meta.id))
                          setEditing(false)
                          setNotice(t('记忆已保存。', 'Memory saved.'))
                        })
                      }
                    >
                      {t('保存记忆', 'Save memory')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setEditing(false)}>
                      {t('取消', 'Cancel')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="managed-session-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setText(memory)
                        setEditing(true)
                      }}
                    >
                      {t('修改记忆', 'Edit memory')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await mutation.current.apply(api, currentView, {
                            kind: 'set_memory_enabled',
                            enabled: meta.memoryDisabled === true,
                          })
                          setView(await api.get(meta.id))
                          setNotice(
                            meta.memoryDisabled
                              ? t('已恢复引用。', 'Memory use restored.')
                              : t(
                                  '已暂停引用，可随时恢复。',
                                  'Memory use paused. You can restore it at any time.',
                                ),
                          )
                        })
                      }
                    >
                      {meta.memoryDisabled
                        ? t('恢复引用', 'Restore use')
                        : t('暂停引用', 'Pause use')}
                    </button>
                  </div>
                  <details className="memory-content" key={meta.id}>
                    <summary>
                      <strong>
                        {currentView.session.summary.mode === 'manual'
                          ? t('人工备注', 'Manual note')
                          : t('对话摘要', 'Conversation notes')}
                      </strong>
                      <span className="memory-preview">
                        {memoryPreview || t('还没有对话摘要', 'No conversation notes yet')}
                      </span>
                    </summary>
                    <WorkspaceMarkdown
                      allowImages={false}
                      value={
                        memory ||
                        t(
                          '这段对话尚未记录具体内容。',
                          'No conversation content has been recorded yet.',
                        )
                      }
                    />
                  </details>
                  {currentView.session.summary.mode === 'manual' &&
                  currentView.session.context.messages.length > 0 &&
                  currentView.session.memory?.automaticEntries.length ? (
                    <details className="memory-content">
                      <summary>
                        <strong>{t('后续对话补充', 'Additional conversation notes')}</strong>
                      </summary>
                      <WorkspaceMarkdown
                        allowImages={false}
                        value={currentView.session.memory.automaticEntries
                          .map((entry) => readableGeneratedMemory(entry.markdown, zh))
                          .join('\n\n')}
                      />
                    </details>
                  ) : null}
                  <OutcomeMemoryList
                    entries={currentView.session.memory?.outcomes ?? []}
                    lang={lang}
                  />
                </>
              )}
            </>
          ) : (
            <div className="memory-detail-empty">
              {loaded && !sessions.length && !error && (
                <div className="managed-session-empty-illustration">
                  <DogIllustration scene="memory" />
                </div>
              )}
              {!error &&
                (meta
                  ? t('正在读取记忆…', 'Loading memory…')
                  : !loaded
                    ? null
                    : !sessions.length
                      ? t('聊过的内容会自动保存到这里。', 'BigDog saves memories as you chat.')
                      : visible.length > 0
                        ? t('选择一条记忆查看内容。', 'Select a memory to see its content.')
                        : null)}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
