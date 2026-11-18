import { useCallback, useEffect, useRef, useState } from 'react'
import type { ManagedSessionMeta, SessionView } from '@genoffice/project-store'
import { WorkspaceMarkdown } from './WorkspaceMarkdown'
import { OutcomeMemoryList } from './OutcomeMemoryList'
import { DogIllustration } from './DogIllustration'
import { stripMemoryContextEcho } from '@genoffice/project-store/browser'
import { SessionMutationDraft, sessionMutationError } from './session-mutations'
import './managed-sessions.css'

export function readableMemory(view: SessionView, zh: boolean): string {
  if (view.session.summary.mode === 'manual') return view.markdown
  if (!view.session.context.messages.length && !view.session.context.pendingInput) return ''
  return readableGeneratedMemory(view.markdown, zh)
}
function readableGeneratedMemory(markdown: string, zh: boolean): string {
  // The generated note also stores recovery metadata, which belongs in advanced management.
  return stripMemoryContextEcho(markdown)
    .split('## Budget')[0]!
    .split(/(?=## )/)
    .slice(1)
    .join('')
    .replace('## Earlier context', zh ? '之前的内容' : 'Earlier context')
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
  onClose,
  onAdvanced,
}: {
  lang: string
  onClose(): void
  onAdvanced(): void
}) {
  const api = window.managedSessions!
  const zh = /^zh/i.test(lang)
  const t = (cn: string, en: string) => (zh ? cn : en)
  const [sessions, setSessions] = useState<ManagedSessionMeta[]>([])
  const [selected, setSelected] = useState<string | null>(null)
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
  const cancelRefresh = useCallback(() => {
    request.current++
  }, [])
  const refresh = useCallback(async () => {
    const sequence = ++request.current
    const all = await api.list()
    if (sequence === request.current) setSessions(all.filter((m) => m.purpose !== 'maintenance'))
  }, [api])
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
  const meta = sessions.find((m) => m.id === selected)
  const visible = matches ? sessions.filter((m) => matches.has(m.id)) : sessions
  const title = (m: ManagedSessionMeta) =>
    /^(New session|New conversation|新会话|新对话)$/i.test(m.title)
      ? t('未命名对话', 'Untitled conversation')
      : m.title
  return (
    <section className="managed-sessions memory-panel" aria-label={t('记忆管理', 'Memory')}>
      <header>
        <div>
          <strong>{t('大狗记住了什么', 'What BigDog remembers')}</strong>
          <small>
            {t(
              '相关记忆会自动用于对话，无需整理或选择。你可以随时修改，或停止自动引用。',
              'Relevant memories are used automatically. Edit them or stop using them whenever you need.',
            )}
          </small>
        </div>
        <button onClick={onClose} aria-label={t('关闭记忆', 'Close memory')}>
          ×
        </button>
      </header>
      <div className="managed-session-toolbar">
        <input
          aria-label={t('搜索记忆', 'Search memory')}
          placeholder={t('搜索记住的内容', 'Search remembered content')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={onAdvanced}>{t('高级管理', 'Advanced management')}</button>
      </div>
      {error && (
        <p role="alert" className="managed-session-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="managed-session-body" aria-busy={busy || searching}>
        <nav aria-label={t('记忆来源', 'Memory sources')}>
          {!visible.length && !searching && (
            <div className="managed-session-empty">
              {!error && (
                <div className="managed-session-empty-illustration">
                  <DogIllustration scene="memory" />
                </div>
              )}
              <p>
                {query
                  ? t(
                      '没有匹配的记忆，试试其他关键词。',
                      'No matching memories. Try another search.',
                    )
                  : t(
                      '还没有相关记忆。正常对话后，大狗会自动保存。',
                      'No memories yet. BigDog saves them as you chat.',
                    )}
              </p>
            </div>
          )}
          {visible.map((m) => (
            <button
              key={m.id}
              disabled={busy || editing}
              className={m.id === selected ? 'selected' : ''}
              onClick={() => setSelected(m.id)}
            >
              <strong>{title(m)}</strong>
              <small>
                {m.memoryDisabled
                  ? t('已停止自动引用', 'Not used automatically')
                  : t('可自动引用', 'Used when relevant')}
              </small>
              <small>
                {m.source?.filePath?.split(/[\\/]/).pop() ?? t('来自对话', 'From a conversation')}
              </small>
            </button>
          ))}
        </nav>
        <div className="managed-session-detail">
          {!view || !meta ? (
            <p>
              {t(
                '选择一条记忆，查看内容和来源。',
                'Choose a memory to see its content and source.',
              )}
            </p>
          ) : (
            <>
              <strong>{title(meta)}</strong>
              <small>
                {t('来源：', 'Source: ')}
                {meta.source?.filePath ?? t('AI 大狗对话', 'AI BigDog conversation')}
              </small>
              <small>
                {t(
                  '对话记录不代表文件已修改；实际成果请查看任务结果。',
                  'Conversation notes are not proof of file changes. See task results for verified outcomes.',
                )}
              </small>
              {editing ? (
                <>
                  <label className="managed-session-memory">
                    {t('修改记忆', 'Edit memory')}
                    <textarea
                      aria-label={t('修改记忆内容', 'Edit memory content')}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </label>
                  <div className="managed-session-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await mutation.current.apply(api, view, {
                            kind: 'update_memory',
                            markdown: text,
                          })
                          setView(await api.get(meta.id))
                          setEditing(false)
                          setNotice(
                            t(
                              '记忆已保存，后续对话会保留你的修改。',
                              'Memory saved. Future conversations will preserve your edits.',
                            ),
                          )
                        })
                      }
                    >
                      {t('保存记忆', 'Save memory')}
                    </button>
                    <button disabled={busy} onClick={() => setEditing(false)}>
                      {t('取消', 'Cancel')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <OutcomeMemoryList entries={view.session.memory?.outcomes ?? []} lang={lang} />
                  <div className="memory-content">
                    <WorkspaceMarkdown
                      allowImages={false}
                      value={
                        readableMemory(view, zh) ||
                        t(
                          '这段对话尚未记录具体内容。',
                          'No conversation content has been recorded yet.',
                        )
                      }
                    />
                  </div>
                  {view.session.summary.mode === 'manual' &&
                  view.session.context.messages.length > 0 &&
                  view.session.memory?.automaticEntries.length ? (
                    <>
                      <strong>{t('后续对话补充', 'Additional conversation notes')}</strong>
                      <WorkspaceMarkdown
                        allowImages={false}
                        value={view.session.memory.automaticEntries
                          .map((entry) => readableGeneratedMemory(entry.markdown, zh))
                          .join('\n\n')}
                      />
                    </>
                  ) : null}
                  <div className="managed-session-actions">
                    <button
                      disabled={busy}
                      onClick={() => {
                        setText(readableMemory(view, zh))
                        setEditing(true)
                      }}
                    >
                      {t('修改', 'Edit')}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await mutation.current.apply(api, view, {
                            kind: 'set_memory_enabled',
                            enabled: meta.memoryDisabled === true,
                          })
                          setNotice(
                            meta.memoryDisabled
                              ? t('已恢复自动引用。', 'Automatic use restored.')
                              : t(
                                  '已停止自动引用。对话和原文仍保留，可随时恢复。',
                                  'No longer used automatically. The conversation and note are retained and can be restored.',
                                ),
                          )
                        })
                      }
                    >
                      {meta.memoryDisabled
                        ? t('恢复自动引用', 'Restore automatic use')
                        : t('忘记（不再自动引用）', 'Forget (stop automatic use)')}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
