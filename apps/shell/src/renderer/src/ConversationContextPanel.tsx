import { useEffect, useRef, useState } from 'react'
import type {
  ManagedProject,
  ManagedSessionMeta,
  SessionContextSelection,
} from '@genoffice/project-store'
import type { AgentContextPreview } from '../../shared/workspace-agent-api'
import { FileBadge } from './file-badge'
import type { ChatReferenceFile } from './workspace-chat-files'
import './conversation-context.css'

interface ConversationContextProps {
  id: string
  sessionId: string
  lang: string
  selection: SessionContextSelection | null
  files: ChatReferenceFile[]
  preview: AgentContextPreview | null
  busy: boolean
  error: string | null
  onClose(): void
  onManageMemory?: () => void
  onAddFiles(): void
  onOpenFile(path: string): void
  onRemoveFile(path: string): Promise<void>
  onChange(update: (selection: SessionContextSelection) => SessionContextSelection): Promise<void>
}

export function ConversationContextPanel({
  id,
  sessionId,
  lang,
  selection,
  files,
  preview,
  busy,
  error,
  onClose,
  onManageMemory,
  onAddFiles,
  onOpenFile,
  onRemoveFile,
  onChange,
}: ConversationContextProps) {
  const zh = /^zh/i.test(lang)
  const t = (cn: string, en: string) => (zh ? cn : en)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [failure, setFailure] = useState('')
  const sourceCount = preview?.memory.sources.length ?? 0

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true })
  }, [])

  const run = async (action: () => Promise<void>) => {
    setFailure('')
    try {
      await action()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const change: ConversationContextProps['onChange'] = (update) => run(() => onChange(update))

  return (
    <section
      id={id}
      className="conversation-context"
      aria-label={t('对话上下文', 'Conversation context')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.stopPropagation()
        onClose()
      }}
    >
      <header className="conversation-context-head">
        <h2 ref={titleRef} tabIndex={-1}>
          {t('文件与记忆', 'Files & memory')}
        </h2>
        <button
          type="button"
          className="context-icon-button"
          onClick={onClose}
          aria-label={t('关闭上下文', 'Close context')}
        >
          ×
        </button>
      </header>
      <div className="conversation-context-body" aria-busy={busy}>
        {(error || failure) && (
          <p className="context-error" role="alert">
            {failure || error}
          </p>
        )}
        {!selection && !error && (
          <p className="context-hint" role="status">
            {t('正在读取引用…', 'Loading references…')}
          </p>
        )}
        {selection && (
          <>
            <section>
              <div className="context-section-head">
                <h3>
                  {t('参考文件', 'Reference files')}
                  {files.length > 0 && <span>{files.length}</span>}
                </h3>
                <button
                  type="button"
                  className="context-add-button"
                  disabled={busy}
                  onClick={onAddFiles}
                >
                  <span aria-hidden="true">+</span>
                  {t('添加文件', 'Add files')}
                </button>
              </div>
              {files.length ? (
                <ul className="context-file-list">
                  {files.map((file) => {
                    const fileError = preview?.files.find((item) => item.path === file.path)?.error
                    return (
                      <li className="context-file" key={file.path}>
                        <FileBadge size={22} ext={file.type === 'unknown' ? '' : file.type} />
                        <div className="context-file-copy">
                          <button
                            type="button"
                            className="context-file-name"
                            title={file.path}
                            onClick={() => onOpenFile(file.path)}
                          >
                            {file.name}
                          </button>
                          {fileError && (
                            <small className="context-file-error" title={fileError}>
                              {t('文件无法读取', 'File unavailable')}
                            </small>
                          )}
                        </div>
                        <button
                          type="button"
                          className="context-icon-button"
                          disabled={busy}
                          aria-label={t('移除文件 ', 'Remove file ') + file.name}
                          onClick={() => void run(() => onRemoveFile(file.path))}
                        >
                          ×
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="context-empty-files">
                  {t(
                    '还没有参考文件，可直接拖入对话。',
                    'Drop files into the conversation to add them.',
                  )}
                </p>
              )}
            </section>
            <label className="context-memory-toggle">
              <span>
                <strong>{t('自动记忆', 'Automatic memory')}</strong>
                <small>
                  {t('根据本对话查找相关记忆', 'Find relevant memories for this conversation')}
                </small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label={t('自动记忆', 'Automatic memory')}
                disabled={busy}
                checked={selection.workspaceMemory}
                onChange={(event) => {
                  const checked = event.currentTarget.checked
                  void change((current) => ({ ...current, workspaceMemory: checked }))
                }}
              />
            </label>
            <details
              className="context-memory-sources"
              onToggle={(event) => setSourcesOpen(event.currentTarget.open)}
            >
              <summary>
                <span>{t('记忆来源', 'Memory sources')}</span>
                {sourceCount > 0 && (
                  <small>{t(`${sourceCount} 份匹配`, `${sourceCount} matched`)}</small>
                )}
              </summary>
              {sourcesOpen && (
                <ContextMemorySources
                  sessionId={sessionId}
                  lang={lang}
                  selection={selection}
                  sources={preview?.memory.sources ?? []}
                  busy={busy}
                  onChange={change}
                />
              )}
            </details>
          </>
        )}
      </div>
      {onManageMemory && (
        <footer className="conversation-context-footer">
          <button type="button" onClick={onManageMemory}>
            {t('记忆管理', 'Manage memory')} <span aria-hidden="true">→</span>
          </button>
        </footer>
      )}
    </section>
  )
}

function ContextMemorySources({
  sessionId,
  lang,
  selection,
  sources,
  busy,
  onChange,
}: {
  sessionId: string
  lang: string
  selection: SessionContextSelection
  sources: AgentContextPreview['memory']['sources']
  busy: boolean
  onChange: ConversationContextProps['onChange']
}) {
  const t = (cn: string, en: string) => (/^zh/i.test(lang) ? cn : en)
  const [catalog, setCatalog] = useState<{
    sessions: ManagedSessionMeta[]
    projects: ManagedProject[]
  } | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const api = window.managedSessions
  useEffect(() => {
    if (!api) return
    let alive = true
    void Promise.all([api.list(), api.projects()])
      .then(([sessions, projects]) => {
        if (alive)
          setCatalog({
            sessions: sessions.filter((item) => item.purpose !== 'maintenance'),
            projects,
          })
      })
      .catch((cause) => {
        if (alive) setError(String(cause))
      })
    return () => {
      alive = false
    }
  }, [api])

  const toggle = (key: 'projectIds' | 'sessionIds', id: string) =>
    void onChange((current) => {
      const selected = current[key].includes(id)
      return {
        ...current,
        [key]: selected ? current[key].filter((value) => value !== id) : [...current[key], id],
        ...(key === 'sessionIds' &&
          !selected && {
            excludedSessionIds: current.excludedSessionIds?.filter((value) => value !== id),
          }),
      }
    })

  const candidates =
    catalog?.sessions.filter(
      (item) =>
        item.id !== sessionId &&
        item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? []
  const excluded = selection.excludedSessionIds ?? []
  return (
    <div className="context-source-body">
      {sources.length > 0 && (
        <section>
          <h4>{t('匹配的记忆', 'Matched memories')}</h4>
          {sources.map((source) => (
            <div className="context-source-row" key={source.id}>
              <span title={source.title}>{source.title}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void onChange((current) => ({
                    ...current,
                    sessionIds: current.sessionIds.filter((id) => id !== source.id),
                    excludedSessionIds: [
                      ...new Set([...(current.excludedSessionIds ?? []), source.id]),
                    ],
                  }))
                }
              >
                {t('排除', 'Exclude')}
              </button>
            </div>
          ))}
        </section>
      )}
      {excluded.length > 0 && (
        <section>
          <h4>{t('本对话已排除', 'Excluded in this conversation')}</h4>
          {excluded.map((id) => {
            const name =
              catalog?.sessions.find((item) => item.id === id)?.title ??
              t('已排除的记忆', 'Excluded memory')
            return (
              <div className="context-source-row" key={id}>
                <span title={name}>{name}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void onChange((current) => ({
                      ...current,
                      excludedSessionIds: current.excludedSessionIds?.filter(
                        (value) => value !== id,
                      ),
                    }))
                  }
                >
                  {t('恢复', 'Allow again')}
                </button>
              </div>
            )
          })}
        </section>
      )}
      {error && (
        <p role="alert" className="context-error">
          {error}
        </p>
      )}
      {api && !catalog && !error && (
        <p className="context-hint" role="status">
          {t('正在加载来源…', 'Loading sources…')}
        </p>
      )}
      {catalog && (
        <>
          <details className="context-source-options">
            <summary>
              {t('按项目选择', 'Choose by project')}
              {selection.projectIds.length > 0 && ` (${selection.projectIds.length})`}
            </summary>
            {catalog.projects.map((project) => (
              <label key={project.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selection.projectIds.includes(project.id)}
                  onChange={() => toggle('projectIds', project.id)}
                />
                {project.id === 'default' ? t('未分类', 'Unassigned') : project.name}
              </label>
            ))}
          </details>
          <details className="context-source-options">
            <summary>
              {t('按对话选择', 'Choose conversations')}
              {selection.sessionIds.length > 0 && ` (${selection.sessionIds.length})`}
            </summary>
            <input
              type="search"
              placeholder={t('搜索对话', 'Search conversations')}
              aria-label={t('搜索记忆', 'Search memories')}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <div className="context-source-candidates">
              {candidates.length === 0 && (
                <p className="context-hint">
                  {query.trim()
                    ? t('没有匹配的对话。', 'No matching conversations.')
                    : t('还没有其他对话。', 'No other conversations yet.')}
                </p>
              )}
              {candidates.map((candidate) => (
                <label key={candidate.id} title={candidate.title}>
                  <input
                    type="checkbox"
                    disabled={
                      busy ||
                      (candidate.memoryDisabled && !selection.sessionIds.includes(candidate.id))
                    }
                    checked={selection.sessionIds.includes(candidate.id)}
                    onChange={() => toggle('sessionIds', candidate.id)}
                  />
                  <span>
                    {candidate.title}
                    {candidate.memoryDisabled && (
                      <small className="context-hint">{t(' · 已暂停引用', ' · Paused')}</small>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  )
}
