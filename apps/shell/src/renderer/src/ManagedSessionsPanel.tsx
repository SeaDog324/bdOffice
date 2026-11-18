import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ManagedProject,
  ManagedSessionMeta,
  ManagedSessionsApi,
  SessionView,
} from '@genoffice/project-store'
import './managed-sessions.css'
import { DogIllustration } from './DogIllustration'
import { SessionMutationDraft, sessionMutationError, type SessionChange } from './session-mutations'

declare global {
  interface Window {
    managedSessions?: ManagedSessionsApi
  }
}

export function sessionTreeRows(
  sessions: ManagedSessionMeta[],
): Array<{ meta: ManagedSessionMeta; depth: number }> {
  const ids = new Set(sessions.map((s) => s.id)),
    seen = new Set<string>(),
    rows: Array<{ meta: ManagedSessionMeta; depth: number }> = []
  const visit = (meta: ManagedSessionMeta, depth: number) => {
    if (seen.has(meta.id)) return
    seen.add(meta.id)
    rows.push({ meta, depth })
    for (const child of sessions.filter((s) => s.parentId === meta.id)) visit(child, depth + 1)
  }
  for (const root of sessions.filter((s) => !s.parentId || !ids.has(s.parentId))) visit(root, 0)
  return rows
}

export function ManagedSessionsPanel({
  lang,
  onClose,
  onResume,
  onFolder,
  onLoadMemory,
  currentSessionId,
}: {
  lang: string
  onClose(): void
  onResume(id: string): Promise<void>
  onFolder(): void
  onLoadMemory?(id: string): Promise<void>
  currentSessionId?: string | null
}) {
  const api = window.managedSessions!
  const zh = /^zh/i.test(lang),
    label = (cn: string, en: string) => (zh ? cn : en)
  const [projects, setProjects] = useState<ManagedProject[]>([])
  const [sessions, setSessions] = useState<ManagedSessionMeta[]>([])
  const [project, setProject] = useState('')
  const [state, setState] = useState<'active' | 'archived' | 'trashed'>('active')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<SessionView | null>(null)
  const [name, setName] = useState(''),
    [markdown, setMarkdown] = useState('')
  const [targetProject, setTargetProject] = useState('default'),
    [parent, setParent] = useState('')
  const [projectName, setProjectName] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const request = useRef(0),
    detailRequest = useRef(0)
  const mutation = useRef(new SessionMutationDraft()),
    lock = useRef(false)
  const cancelRefresh = useCallback(() => {
    request.current++
  }, [])
  const refresh = useCallback(async () => {
    const seq = ++request.current
    const [p, s] = await Promise.all([api.projects(), api.list({ state: 'all' })])
    if (seq === request.current) {
      setProjects(p)
      setSessions(s)
    }
  }, [api])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    void refresh().catch((e) => setError(String(e)))
    const off = api.onChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh().catch((e) => setError(String(e))), 150)
    })
    return () => {
      off()
      clearTimeout(timer)
      cancelRefresh()
    }
  }, [api, refresh, cancelRefresh])
  useEffect(() => {
    const seq = ++detailRequest.current
    setView(null)
    if (!selected) return
    void api
      .get(selected)
      .then((v) => {
        if (seq !== detailRequest.current) return
        setView(v)
        setName(v.session.meta.title)
        setMarkdown(v.markdown)
        setTargetProject(v.session.meta.projectId)
        setParent(v.session.meta.parentId ?? '')
      })
      .catch((e) => {
        if (seq === detailRequest.current) setError(String(e))
      })
  }, [selected, api])
  const run = async (action: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
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
  const changeSession = async (change: SessionChange) => {
    if (!view) return
    const current = view
    const version = await mutation.current.apply(api, current, change)
    if (version)
      setView((previous) =>
        previous?.session.meta.id === current.session.meta.id ? { ...previous, version } : previous,
      )
  }
  const visible = sessions.filter(
    (s) =>
      s.state === state &&
      (!project || s.projectId === project) &&
      (!query ||
        `${s.title} ${s.summaryPreview}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
  )
  const meta = sessions.find((s) => s.id === selected) ?? view?.session.meta
  const active = meta?.state === 'active',
    running = meta?.phase === 'running'
  const currentProject = projects.find((p) => p.id === project)
  const projectLabel = (p: ManagedProject) =>
    p.id === 'default' && p.name === 'Unassigned' ? label('未分类', 'Unassigned') : p.name
  const create = async (parentId?: string) => {
    const m = await api.create(parentId ? meta?.projectId : project || 'default', parentId)
    setState('active')
    setSelected(m.id)
    if (parentId) setProject(m.projectId)
  }
  const resume = async () => {
    if (!selected) return
    const result = await api.resume(selected)
    if (result.cancelled) return
    if (result.sessionId) await onResume(result.sessionId)
    onClose()
  }
  return (
    <section
      className="managed-sessions"
      role="region"
      aria-label={label('Session 管理', 'Session management')}
    >
      <header>
        <div>
          <strong>{label('Session 管理', 'Session management')}</strong>
          <small>
            {label(
              '项目可独立于文件夹；回收站始终保留，直到你手动销毁。',
              'Projects work without folders. Recycle bin items stay until you destroy them manually.',
            )}
          </small>
        </div>
        <button onClick={onClose} aria-label={label('关闭管理', 'Close manager')}>
          ×
        </button>
      </header>
      <div className="managed-session-project">
        <select
          aria-label={label('项目筛选', 'Project filter')}
          value={project}
          onChange={(e) => {
            setProject(e.target.value)
            setProjectName('')
          }}
        >
          <option value="">{label('所有项目', 'All projects')}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {projectLabel(p)}
            </option>
          ))}
        </select>
        <input
          aria-label={label('项目名称', 'Project name')}
          placeholder={label('项目名称', 'Project name')}
          maxLength={160}
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
        />
        <button
          disabled={busy || !projectName.trim()}
          onClick={() =>
            void run(async () => {
              const p = await api.createProject(projectName)
              setProject(p.id)
              setProjectName('')
            })
          }
        >
          {label('新建项目', 'New project')}
        </button>
        {project && (
          <button
            disabled={busy || !projectName.trim()}
            onClick={() => void run(() => api.renameProject(project, projectName))}
          >
            {label('项目改名', 'Rename project')}
          </button>
        )}
        {project && (
          <button
            disabled={busy}
            title={currentProject?.folder}
            onClick={() => void run(() => api.bindProjectFolder(project))}
          >
            {label('关联文件夹', 'Connect folder')}
          </button>
        )}
        <button disabled={busy} onClick={onFolder}>
          {label('选择文件夹工作区', 'Choose folder workspace')}
        </button>
        {currentProject && (
          <small>
            {currentProject.folder ?? label('文件由应用自动管理', 'Files managed by the app')}
          </small>
        )}
      </div>
      <div className="managed-session-toolbar">
        <select
          aria-label={label('会话状态', 'Session state')}
          value={state}
          onChange={(e) => setState(e.target.value as typeof state)}
        >
          <option value="active">{label('活跃会话', 'Active')}</option>
          <option value="archived">{label('已归档', 'Archived')}</option>
          <option value="trashed">{label('回收站', 'Recycle bin')}</option>
        </select>
        <input
          aria-label={label('搜索会话', 'Search sessions')}
          placeholder={label('搜索名称或摘要', 'Search name or summary')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button disabled={busy} onClick={() => void run(() => create())}>
          {label('新建会话', 'New session')}
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const m = await api.importSession()
              if (m) {
                setSelected(m.id)
                setProject('')
                setState('active')
              }
            })
          }
        >
          {label('导入', 'Import')}
        </button>
      </div>
      {error && (
        <p role="alert" className="managed-session-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="managed-session-body" aria-busy={busy}>
        <nav aria-label={label('会话列表', 'Sessions')}>
          {!visible.length && (
            <div className="managed-session-empty">
              {!error && (
                <div className="managed-session-empty-illustration">
                  <DogIllustration scene="memory" />
                </div>
              )}
              <p>
                {query
                  ? label(
                      '没有匹配的会话，试试其他关键词。',
                      'No matching conversations. Try another search.',
                    )
                  : label('此处还没有会话。', 'No sessions here yet.')}
              </p>
            </div>
          )}
          {sessionTreeRows(visible).map(({ meta: m, depth }) => (
            <button
              key={m.id}
              className={selected === m.id ? 'selected' : ''}
              style={{ paddingInlineStart: 12 + Math.min(depth, 8) * 14 }}
              onClick={() => setSelected(m.id)}
            >
              <strong>
                {depth > 0 ? '↳ ' : ''}
                {m.title}
              </strong>
              <small>
                {m.kind === 'file' ? label('文件 AI', 'File AI') : label('AI 大狗', 'AI BigDog')} ·{' '}
                {m.phase === 'running' ? label('运行中', 'Running') : label('已保存', 'Saved')}
              </small>
              <small>
                {projects.find((p) => p.id === m.projectId) &&
                  projectLabel(projects.find((p) => p.id === m.projectId)!)}{' '}
                · {new Date(m.updatedAt).toLocaleString()}
              </small>
            </button>
          ))}
        </nav>
        <div className="managed-session-detail">
          {!view || !meta ? (
            <p>
              {label(
                '选择会话查看摘要、预算及恢复入口。',
                'Select a session to view its summary, budget and recovery options.',
              )}
            </p>
          ) : (
            <>
              <div className="managed-session-actions">
                {active && onLoadMemory && meta.id !== currentSessionId && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await onLoadMemory(meta.id)
                        onClose()
                      })
                    }
                  >
                    {label('加载记忆到当前对话', 'Load memory into current chat')}
                  </button>
                )}
                {active && (
                  <button disabled={busy} onClick={() => void run(resume)}>
                    {label('继续会话', 'Continue session')}
                  </button>
                )}
                {running && (
                  <button disabled={busy} onClick={() => void run(() => api.cancel(meta.id))}>
                    {label('停止运行', 'Stop run')}
                  </button>
                )}
                {active && (
                  <button
                    disabled={busy || running}
                    onClick={() => void run(() => create(meta.id))}
                  >
                    {label('新建子会话', 'New child session')}
                  </button>
                )}
                {meta.state !== 'trashed' && (
                  <button
                    disabled={busy || running}
                    onClick={() =>
                      void run(() => changeSession({ kind: 'archive', archived: active }))
                    }
                  >
                    {active ? label('归档', 'Archive') : label('取消归档', 'Unarchive')}
                  </button>
                )}
                {meta.state !== 'trashed' && (
                  <button
                    disabled={busy || running}
                    onClick={() => void run(() => changeSession({ kind: 'trash' }))}
                  >
                    {label('移至回收站', 'Move to recycle bin')}
                  </button>
                )}
                {meta.state === 'trashed' && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => void run(() => changeSession({ kind: 'restore' }))}
                    >
                      {label('恢复', 'Restore')}
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (await api.destroy(meta.id)) {
                            setSelected(null)
                            setView(null)
                          }
                        })
                      }
                    >
                      {label('永久销毁…', 'Destroy permanently…')}
                    </button>
                  </>
                )}
                {meta.state !== 'trashed' && (
                  <button
                    disabled={busy || running}
                    onClick={() =>
                      void run(async () => {
                        const path = await api.exportSession(meta.id)
                        if (path) setNotice(label('已导出：', 'Exported: ') + path)
                      })
                    }
                  >
                    {label('导出 MD + JSON', 'Export MD + JSON')}
                  </button>
                )}
              </div>
              <label>
                {label('会话名称', 'Session name')}
                <input
                  value={name}
                  maxLength={160}
                  disabled={meta.state === 'trashed'}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button
                disabled={busy || !name.trim() || meta.state === 'trashed'}
                onClick={() => void run(() => changeSession({ kind: 'rename', title: name }))}
              >
                {label('保存名称', 'Save name')}
              </button>
              <div className="managed-session-classify">
                <label>
                  {label('所属项目', 'Project')}
                  <select
                    value={targetProject}
                    onChange={(e) => {
                      setTargetProject(e.target.value)
                      setParent('')
                    }}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {projectLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {label('上级会话', 'Parent session')}
                  <select value={parent} onChange={(e) => setParent(e.target.value)}>
                    <option value="">{label('顶层会话', 'Top level')}</option>
                    {sessions
                      .filter(
                        (s) =>
                          s.id !== meta.id && s.projectId === targetProject && s.state === 'active',
                      )
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  disabled={busy || running || meta.state === 'trashed'}
                  onClick={() =>
                    void run(() =>
                      changeSession({
                        kind: 'move',
                        projectId: targetProject,
                        parentId: parent || null,
                      }),
                    )
                  }
                >
                  {label('保存分类', 'Save classification')}
                </button>
              </div>
              <small className="managed-session-budget">
                {label('运行预算', 'Run budget')}: {view.session.context.budget.maxTurns}{' '}
                {label('轮', 'turns')} · {view.session.context.budget.maxHistory}{' '}
                {label('条上下文', 'context messages')} ·{' '}
                {Math.round(view.session.context.budget.runTimeoutMs / 1000)}s<br />
                {label(
                  '恢复对话上下文；可在任务记录中继续符合条件的中断任务，执行前会重新检查。',
                  'Restores conversation context. Eligible interrupted tasks can continue from task history after revalidation.',
                )}
              </small>
              {meta.source?.filePath && <small>{meta.source.filePath}</small>}
              <label className="managed-session-memory">
                {label('记忆摘要（Markdown）', 'Memory summary (Markdown)')}
                <textarea
                  aria-label={label('记忆摘要（Markdown）', 'Memory summary (Markdown)')}
                  spellCheck={false}
                  value={markdown}
                  disabled={meta.state === 'trashed'}
                  onChange={(e) => setMarkdown(e.target.value)}
                />
              </label>
              <button
                disabled={busy || meta.state === 'trashed'}
                onClick={() =>
                  void run(async () => {
                    await changeSession({ kind: 'update_memory', markdown })
                    setNotice(
                      label(
                        '摘要已保存，后续对话不会覆盖手动摘要。',
                        'Summary saved. Future turns will preserve your manual summary.',
                      ),
                    )
                  })
                }
              >
                {label('保存摘要', 'Save summary')}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
