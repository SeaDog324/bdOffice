import { useEffect, useState } from 'react'
import type {
  ManagedProject,
  ManagedSessionMeta,
  SessionContextSelection,
} from '@genoffice/project-store'
import type { AgentContextPreview, WorkspaceAgentApi } from '../../shared/workspace-agent-api'
const empty: SessionContextSelection = {
  workspaceMemory: true,
  sessionIds: [],
  projectIds: [],
  filePaths: [],
}
export function ConversationContextPanel({
  api,
  sessionId,
  lang,
  onClose,
  onChanged,
}: {
  api: WorkspaceAgentApi
  sessionId: string
  lang: string
  onClose(): void
  onChanged(preview: AgentContextPreview): void
}) {
  const zh = /^zh/i.test(lang),
    t = (cn: string, en: string) => (zh ? cn : en)
  const [selection, setSelection] = useState(empty)
  const [preview, setPreview] = useState<AgentContextPreview | null>(null)
  const [sessions, setSessions] = useState<ManagedSessionMeta[]>([])
  const [projects, setProjects] = useState<ManagedProject[]>([])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    let alive = true
    setBusy(true)
    void Promise.all([
      api.previewContext(sessionId),
      window.managedSessions!.list(),
      window.managedSessions!.projects(),
    ])
      .then(([p, s, projects]) => {
        if (!alive) return
        setSelection(p.selection)
        setPreview(p)
        setSessions(s)
        setProjects(projects)
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
      .finally(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [api, sessionId])
  const update = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      const next = await api.previewContext(sessionId)
      setSelection(next.selection)
      setPreview(next)
      onChanged(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (key: 'projectIds' | 'sessionIds', id: string) => {
    const list = selection[key],
      next = {
        ...selection,
        [key]: list.includes(id) ? list.filter((v) => v !== id) : [...list, id],
        ...(key === 'sessionIds' && !list.includes(id)
          ? { excludedSessionIds: selection.excludedSessionIds?.filter((value) => value !== id) }
          : {}),
      }
    void update(() => api.setContextSelection(sessionId, next))
  }
  return (
    <section className="conversation-context" aria-label={t('对话上下文', 'Conversation context')}>
      <header>
        <div>
          <strong>{t('上下文与记忆', 'Context and memory')}</strong>
          <p>
            {t(
              '默认自动使用当前文档和相关记忆，无需手动选择。这里可以补充参考资料或调整来源。',
              'The current document and relevant memories are used automatically. Add references or adjust sources here if needed.',
            )}
          </p>
        </div>
        <button onClick={onClose} aria-label={t('关闭上下文', 'Close context')}>
          ×
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <div className="context-sections" aria-busy={busy}>
        <section>
          <h3>{t('参考文件', 'Reference files')}</h3>
          <button
            disabled={busy}
            onClick={() => void update(() => api.pickContextFiles(sessionId))}
          >
            {t('选择文件…', 'Choose files…')}
          </button>
          {selection.filePaths.map((path) => (
            <div className="context-file" key={path}>
              <span title={path}>{path.split(/[\\/]/).pop()}</span>
              <button
                disabled={busy}
                aria-label={t('移除文件 ', 'Remove file ') + path}
                onClick={() =>
                  void update(() =>
                    api.setContextSelection(sessionId, {
                      ...selection,
                      filePaths: selection.filePaths.filter((p) => p !== path),
                    }),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
          <small>
            {t(
              '大狗可按任务访问普通用户文件；修改时遵循你的审批与保存设置。',
              'BigDog can access user files for your task. Changes follow your approval and save settings.',
            )}
          </small>
        </section>
        <section>
          <h3>{t('自动记忆', 'Automatic memory')}</h3>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={selection.workspaceMemory}
              onChange={(e) =>
                void update(() =>
                  api.setContextSelection(sessionId, {
                    ...selection,
                    workspaceMemory: e.target.checked,
                  }),
                )
              }
            />
            {t(
              '自动使用与当前文档和问题相关的记忆',
              'Use memory relevant to this document and question',
            )}
          </label>
          <details>
            <summary>{t('按项目指定来源（可选）', 'Choose projects (optional)')}</summary>
            <h3>{t('项目记忆', 'Project memory')}</h3>
            {projects.map((p) => (
              <label key={p.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selection.projectIds.includes(p.id)}
                  onChange={() => toggle('projectIds', p.id)}
                />
                {p.id === 'default' ? t('未分类', 'Unassigned') : p.name}
              </label>
            ))}
          </details>
        </section>
        <section>
          <details>
            <summary>
              {t('指定或排除会话记忆（可选）', 'Choose or exclude memories (optional)')}
            </summary>
            <h3>{t('选择会话记忆', 'Session memories')}</h3>
            <input
              placeholder={t('搜索会话', 'Search sessions')}
              aria-label={t('搜索记忆', 'Search memories')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {sessions
              .filter(
                (s) =>
                  s.id !== sessionId &&
                  (!query || s.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
              )
              .map((s) => (
                <label key={s.id}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selection.sessionIds.includes(s.id)}
                    onChange={() => toggle('sessionIds', s.id)}
                  />
                  <span>
                    {s.title}
                    <small>
                      {s.kind === 'file'
                        ? t('文件会话', 'File conversation')
                        : t('对话记忆', 'Conversation memory')}
                    </small>
                  </span>
                </label>
              ))}
            {(selection.excludedSessionIds ?? []).map((id) => (
              <div key={id}>
                <span>
                  {sessions.find((session) => session.id === id)?.title ??
                    t('已排除的会话', 'Excluded conversation')}
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void update(() =>
                      api.setContextSelection(sessionId, {
                        ...selection,
                        excludedSessionIds: selection.excludedSessionIds?.filter(
                          (value) => value !== id,
                        ),
                      }),
                    )
                  }
                >
                  {t('允许使用', 'Allow again')}
                </button>
              </div>
            ))}
          </details>
        </section>
      </div>
      {preview && (
        <footer role="status">
          <strong>
            {t('加载预览', 'Load preview')}: {preview.memory.sources.length}{' '}
            {t('份记忆', 'memories')} · {preview.files.length} {t('个文件', 'files')} ·{' '}
            {preview.characters.toLocaleString()} {t('字符', 'characters')}
          </strong>
          <p>
            {t(
              '记忆摘要最多 12,000 字符，文件摘录最多 16,000 字符；不会恢复历史工具或审批。',
              'Memory summaries use up to 12,000 characters and file excerpts 16,000. Previous tools and approvals are not replayed.',
            )}
          </p>
          {preview.memory.sources.map((s) => (
            <small key={s.id}>
              {s.title} · {s.characters} {s.truncated ? t('（已压缩）', '(condensed)') : ''}
              <button
                disabled={busy}
                onClick={() =>
                  void update(() =>
                    api.setContextSelection(sessionId, {
                      ...selection,
                      sessionIds: selection.sessionIds.filter((id) => id !== s.id),
                      excludedSessionIds: [
                        ...new Set([...(selection.excludedSessionIds ?? []), s.id]),
                      ],
                    }),
                  )
                }
              >
                {t('不再使用', 'Exclude')}
              </button>
            </small>
          ))}
          {preview.memory.omitted > 0 && (
            <small>
              {preview.memory.omitted}{' '}
              {t(
                '份记忆超出预算，仍可通过工具检索',
                'more memories remain available through search tools',
              )}
            </small>
          )}
          {preview.files
            .filter((f) => f.error)
            .map((f) => (
              <p key={f.path} role="alert">
                {f.name}: {f.error}
              </p>
            ))}
        </footer>
      )}
    </section>
  )
}
