import {
  dialog,
  ipcMain,
  webContents,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import type {
  ChatContextController,
  ManagedSessionMeta,
  ManagedSessionStore,
  ProjectStore,
  SessionBundle,
  SessionListFilter,
} from '@genoffice/project-store'
import { SessionService, SessionCommandError, type SessionActor } from '@genoffice/project-store'
import type { WorkspaceAgentRuntime } from './workspace-agent/service'
import { randomUUID } from 'node:crypto'
import type { AssistantTaskService } from './agent-tasks/service'

export const SESSION_CHANNEL = 'managed-session:call'
export const SESSION_CHANGED = 'managed-session:changed'
interface Options {
  store: ManagedSessionStore
  projects(): ProjectStore
  runtime(): WorkspaceAgentRuntime
  chats: ChatContextController
  accepts(event: IpcMainInvokeEvent): boolean
  parent(): BrowserWindow | undefined
  openFile(path: string): Promise<WebContents>
  openHome(chatId: string): void
  language(): string
  tasks?(): AssistantTaskService
  writeUnavailable?(id: string): boolean
}
const object = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const value = (v: unknown) => (typeof v === 'string' ? v : '')
const inside = (root: string, path: string) => {
  const r = relative(root, path)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}
function readOwned(root: string, path: string, cap: number): string {
  if (
    lstatSync(path).isSymbolicLink() ||
    !inside(realpathSync(root), realpathSync(path)) ||
    statSync(path).size > cap
  )
    throw new Error('Invalid session package file.')
  return readFileSync(path, 'utf8')
}
function transcript(
  meta: ReturnType<ManagedSessionStore['get']>,
): import('@genoffice/project-store').ChatMessage[] {
  if (meta.session.transcript.length) return meta.session.transcript
  return meta.session.context.messages
    .filter(
      (m): m is Extract<typeof m, { role: 'user' | 'assistant' }> =>
        m.role === 'user' || m.role === 'assistant',
    )
    .map((m, seq) => ({ seq, ts: meta.session.context.updatedAt, role: m.role, text: m.text }))
}

/** Only trusted Shell/Agent frames can manage the catalog. File frames retain scoped chat IPC. */
export function registerSessionManagement(options: Options) {
  const store = options.store
  store.setWriteGuard(options.writeUnavailable)
  const service = new SessionService(store, {
    writeUnavailable: options.writeUnavailable,
    unavailable: (id) => options.tasks?.().store.sessionPurged(id) ?? false,
  })
  const actor: SessionActor = {
    principalId: 'local-user',
    deviceId: 'desktop',
    permissions: ['sessions:read', 'sessions:write', 'memory:read', 'memory:write'],
  }
  const mutate = (
    kind: string,
    id: string,
    extra: Record<string, unknown>,
    request: Record<string, unknown> = {},
  ) => {
    if (request.requestId !== undefined && request.expected === undefined)
      throw new SessionCommandError(
        'INVALID_COMMAND',
        'A retried command must retain its original expected version.',
      )
    return service.execute(actor, {
      kind,
      requestId: request.requestId === undefined ? randomUUID() : request.requestId,
      sessionId: id,
      expected: request.expected === undefined ? store.version(id) : request.expected,
      ...extra,
    })
  }
  let migrated: Promise<void> | undefined
  const migrate = () =>
    (migrated ??= (async () => {
      await options.runtime().listSessions()
      const projects = options.projects()
      projects.ensureDefaultProject()
      for (const project of projects.listProjects()) {
        for (const chat of projects.listChats(project.id)) {
          try {
            projects.managedChat(project.id, chat.chatId)
          } catch {
            /* retain unreadable legacy originals */
          }
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    })())
  store.onChanged(() => {
    for (const contents of webContents.getAllWebContents())
      if (!contents.isDestroyed()) contents.send(SESSION_CHANGED)
  })
  const pickFolder = async (title: string): Promise<string | null> => {
    const parent = options.parent()
    const opts = {
      title,
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >,
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
  const zh = () => /^zh/i.test(options.language())
  const idsInTree = (id: string): ManagedSessionMeta[] => {
    const all = store.list({ state: 'all' }),
      out: ManagedSessionMeta[] = []
    const queue = [id]
    const seen = new Set<string>()
    while (queue.length) {
      const next = queue.shift()!
      if (seen.has(next)) throw new Error('Invalid session hierarchy.')
      seen.add(next)
      const meta = all.find((m) => m.id === next)
      if (!meta) throw new Error('Unknown session.')
      out.push(meta)
      queue.push(...all.filter((m) => m.parentId === next).map((m) => m.id))
    }
    return out
  }
  const ensureStopped = (id: string) => {
    if (idsInTree(id).some((m) => m.phase === 'running'))
      throw new Error('Stop the running session first.')
  }
  const create = async (projectId = 'default', parentId?: string) => {
    const receipt = service.execute(actor, {
      kind: 'create',
      requestId: randomUUID(),
      title: zh() ? '\u65b0\u4f1a\u8bdd' : 'New session',
      projectId,
      ...(parentId ? { parentId } : {}),
    })
    return store.info(receipt.sessionId)
  }
  const resume = async (id: string) => {
    if (options.tasks?.().store.sessionPurged(id))
      throw new Error('This session is being permanently removed.')
    let view = store.get(id),
      meta = view.session.meta
    if (meta.state !== 'active') {
      store.restore(id)
      view = store.get(id)
      meta = view.session.meta
    }
    if (meta.kind === 'workspace' || meta.kind === 'home') {
      const runtime = options.runtime()
      if (!meta.source?.sessionId) await runtime.importManagedSession(id, meta.projectId)
      const summary = await runtime.resumeSession(meta.source?.sessionId ?? id)
      options.openHome(summary.id)
      return { kind: meta.kind, sessionId: summary.id }
    }
    const projects = options.projects()
    let path = meta.source?.filePath
    if (meta.needsBinding || !path || !existsSync(path)) {
      const parent = options.parent()
      const opts = {
        title: zh()
          ? '\u9009\u62e9\u7ee7\u7eed\u6b64\u4f1a\u8bdd\u7684\u6587\u6863'
          : 'Choose a document for this conversation',
        properties: ['openFile'] as ['openFile'],
      }
      const picked = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts)
      if (picked.canceled || !picked.filePaths[0]) return { kind: meta.kind, cancelled: true }
      path = realpathSync(picked.filePaths[0])
      const projectId = projects.resolveProjectForFile(path)
      const chatId = meta.id
      const source = { type: 'chat' as const, projectId, chatId, filePath: path }
      store.bindSource(id, source)
      for (const row of transcript(view)) projects.appendChatMessage(projectId, chatId, row)
      meta = store.info(id)
    }
    const source = meta.source!
    const current = projects.resolveChatForFile(path)
    const currentMeta = projects.managedSessions.findSource({ type: 'chat', ...current })
    if (currentMeta?.id !== id && currentMeta?.phase === 'running')
      throw new Error('Stop the current conversation for this document before switching.')
    projects.activateConversation(source.projectId!, source.chatId!, path)
    const contents = await options.openFile(path)
    if (meta.phase !== 'running')
      options.chats.activate(
        contents,
        { projectId: source.projectId!, chatId: source.chatId! },
        path,
      )
    else contents.send('project:show-chat')
    return { kind: meta.kind }
  }
  const cancel = async (id: string) => {
    await options.tasks?.().stopSession(id)
    const meta = store.info(id)
    if (meta.kind === 'workspace' && meta.source?.sessionId)
      await options.runtime().cancel(meta.source.sessionId)
    else {
      const sent = options.chats.cancel(meta.source ?? {})
      if (!sent) {
        const view = store.get(id)
        store.saveContext(id, { ...view.session.context, phase: 'interrupted' })
        return
      }
      const deadline = Date.now() + 10_000
      while (store.info(id).phase === 'running' && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25))
      if (store.info(id).phase === 'running')
        throw new Error('The conversation is still stopping. Wait for its current tool to finish.')
    }
  }
  const exportSession = async (id: string) => {
    ensureStopped(id)
    const folder = await pickFolder(
      zh() ? '\u5bfc\u51fa Session \u5230\u6587\u4ef6\u5939' : 'Export session to folder',
    )
    if (!folder) return null
    const bundle = store.exportSession(id),
      root = realpathSync(folder)
    for (const item of bundle.sessions) {
      const results = await options.runtime().exportTaskResults(item.session.meta, item.results)
      if (results) {
        item.results = results
        bundle.version = 3
      }
    }
    const name = `Session-${store
      .info(id)
      .title.split('')
      .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
      .join('')
      .replace(/[<>:"/\\|?*]/g, '_')
      .slice(0, 50)}-${Date.now()}`
    const entries = bundle.sessions.map((item) => ({
      ...item,
      json: JSON.stringify(item.session, null, 2),
      resultsJson: item.results ? JSON.stringify(item.results) : undefined,
    }))
    if (
      entries.reduce(
        (n, item) =>
          n +
          Buffer.byteLength(item.json) +
          Buffer.byteLength(item.markdown) +
          Buffer.byteLength(item.resultsJson ?? ''),
        0,
      ) >
      64 * 1024 * 1024
    )
      throw new Error('This export exceeds the 64 MiB session package limit.')
    const output = join(root, name)
    mkdirSync(output)
    for (const item of entries) {
      const dir =
        item.session.meta.id === id ? output : join(output, 'children', item.session.meta.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.json'), item.json, { encoding: 'utf8', flag: 'wx' })
      writeFileSync(join(dir, 'summary.md'), item.markdown, { encoding: 'utf8', flag: 'wx' })
      if (item.resultsJson)
        writeFileSync(join(dir, 'results.json'), item.resultsJson, { encoding: 'utf8', flag: 'wx' })
    }
    writeFileSync(
      join(output, 'manifest.json'),
      JSON.stringify(
        {
          schema: bundle.schema,
          version: bundle.version,
          rootId: id,
          ids: bundle.sessions.map((s) => s.session.meta.id),
        },
        null,
        2,
      ),
      { encoding: 'utf8', flag: 'wx' },
    )
    return output
  }
  const importSession = async () => {
    const folder = await pickFolder(
      zh()
        ? '\u9009\u62e9\u5bfc\u51fa\u7684 Session \u6587\u4ef6\u5939'
        : 'Choose an exported session folder',
    )
    if (!folder) return null
    const root = realpathSync(folder)
    const manifest = object(JSON.parse(readOwned(root, join(root, 'manifest.json'), 1024 * 1024)))
    if (
      manifest.schema !== 'bigdog.session-bundle' ||
      (manifest.version !== 1 && manifest.version !== 2 && manifest.version !== 3) ||
      !Array.isArray(manifest.ids) ||
      manifest.ids.length > 200 ||
      !manifest.ids.length
    )
      throw new Error('Unsupported session package.')
    const ids = manifest.ids.map(value)
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[-0-9a-f]{20,64}$/i.test(id)) ||
      !ids.includes(value(manifest.rootId))
    )
      throw new Error('Invalid session package paths.')
    let total = 0
    const sessions = ids.map((id) => {
      const dir = id === manifest.rootId ? root : join(root, 'children', id)
      const json = readOwned(root, join(dir, 'session.json'), 64 * 1024 * 1024),
        markdown = readOwned(root, join(dir, 'summary.md'), 256 * 1024)
      const resultPath = join(dir, 'results.json')
      const results =
        manifest.version === 3 && existsSync(resultPath)
          ? readOwned(root, resultPath, 64 * 1024 * 1024)
          : undefined
      total +=
        Buffer.byteLength(json) + Buffer.byteLength(markdown) + Buffer.byteLength(results ?? '')
      if (total > 64 * 1024 * 1024) throw new Error('Session package is too large.')
      const session = JSON.parse(json)
      if (session.meta?.id !== id) throw new Error('Session package identity mismatch.')
      return { session, markdown, ...(results ? { results: JSON.parse(results) } : {}) }
    })
    return store.importSession({
      schema: 'bigdog.session-bundle',
      version: manifest.version,
      rootId: value(manifest.rootId),
      sessions,
    } satisfies SessionBundle)
  }
  const finishPurge = async (root: string, ids: string[], job?: string) => {
    const available = store.list({ state: 'all' }),
      retained = available.filter((item) => ids.includes(item.id))
    if (
      retained.some((item) => item.state !== 'trashed') ||
      available.some(
        (item) => item.parentId && ids.includes(item.parentId) && !ids.includes(item.id),
      )
    )
      throw new Error('The confirmed removal scope changed.')
    if (retained.length) {
      for (const source of store.bindingsFor(root)) {
        if (source.type === 'workspace' && source.sessionId)
          await options.runtime().deleteSession(source.sessionId, true)
        else if (source.projectId && source.chatId)
          options.projects().deleteChat(source.projectId, source.chatId)
      }
      for (const id of ids) await options.runtime().purgeTaskResults(id)
      store.destroy(root)
    }
    if (job) options.tasks?.().store.completePurge(job)
  }
  ipcMain.handle(SESSION_CHANNEL, async (event, action: unknown, input: unknown) => {
    if (!options.accepts(event))
      throw new Error('Session management requires the trusted Agent or Shell window.')
    const a = object(input),
      id = value(a.id)
    await migrate()
    switch (action) {
      case 'projects':
        return store.projects()
      case 'create-project':
        return store.createProject(value(a.name))
      case 'rename-project':
        return store.renameProject(id, value(a.name))
      case 'bind-project': {
        const folder = await pickFolder(
          zh() ? '\u7ed1\u5b9a\u9879\u76ee\u6587\u4ef6\u5939' : 'Connect a project folder',
        )
        return folder ? store.bindProjectFolder(id, folder) : null
      }
      case 'list':
        return service.list(actor, a as SessionListFilter)
      case 'get':
        return service.get(actor, id)
      case 'command':
        return service.execute(actor, input)
      case 'create':
        return create(value(a.projectId) || 'default', value(a.parentId) || undefined)
      case 'rename':
        mutate('rename', id, { title: value(a.title) }, a)
        return store.info(id)
      case 'move':
        mutate(
          'move',
          id,
          { projectId: value(a.projectId), parentId: value(a.parentId) || null },
          a,
        )
        return
      case 'archive':
        if (a.archived === true)
          for (const meta of idsInTree(id)) await options.tasks?.().stopSession(meta.id)
        mutate('archive', id, { archived: a.archived === true }, a)
        return
      case 'trash':
        for (const meta of idsInTree(id)) await options.tasks?.().stopSession(meta.id)
        mutate('trash', id, {}, a)
        return
      case 'restore':
        if (idsInTree(id).some((meta) => options.tasks?.().store.sessionPurged(meta.id)))
          throw new Error('This session is being permanently removed.')
        mutate('restore', id, {}, a)
        return
      case 'summary':
        mutate('update_memory', id, { markdown: value(a.markdown) }, a)
        return
      case 'memory-enabled':
        if (typeof a.enabled !== 'boolean') throw new Error('Invalid memory setting.')
        mutate('set_memory_enabled', id, { enabled: a.enabled }, a)
        return
      case 'resume':
        return resume(id)
      case 'cancel':
        return cancel(id)
      case 'export':
        return exportSession(id)
      case 'import':
        return importSession()
      case 'destroy': {
        ensureStopped(id)
        const selected = idsInTree(id)
        if (selected.some((m) => m.state !== 'trashed'))
          throw new Error('Move the session to the recycle bin first.')
        const signature = JSON.stringify(selected.map((m) => [m.id, m.revision, m.state]))
        const parent = options.parent()
        const opts = {
          type: 'warning' as const,
          title: zh() ? '\u6c38\u4e45\u9500\u6bc1\u4f1a\u8bdd' : 'Permanently destroy session',
          message: store.info(id).title,
          detail: zh()
            ? `\u5c06\u6c38\u4e45\u5220\u9664 ${selected.length} \u4e2a\u4f1a\u8bdd\u7684\u6458\u8981\u548c\u6062\u590d\u6570\u636e\uff0c\u65e0\u6cd5\u64a4\u9500\u3002\u4e0d\u4f1a\u5220\u9664\u9879\u76ee\u6587\u6863\u3002`
            : `Permanently delete summary and recovery data for ${selected.length} session(s). This cannot be undone. Project documents are not deleted.`,
          buttons: zh()
            ? ['\u53d6\u6d88', '\u6c38\u4e45\u9500\u6bc1']
            : ['Cancel', 'Destroy permanently'],
          defaultId: 0,
          cancelId: 0,
        }
        const answer = parent
          ? await dialog.showMessageBox(parent, opts)
          : await dialog.showMessageBox(opts)
        if (answer.response !== 1) return false
        if (signature !== JSON.stringify(idsInTree(id).map((m) => [m.id, m.revision, m.state])))
          throw new Error('The session changed while confirmation was open. Review it again.')
        const ids = selected.map((meta) => meta.id)
        const job = options.tasks?.().store.purgeSessions(ids, randomUUID())
        await finishPurge(id, ids, job)
        return true
      }
      default:
        throw new Error('Unknown session management operation.')
    }
  })
  return {
    service,
    resume,
    start() {
      try {
        store.reconcileInterrupted()
      } catch {
        // Preserve the application window. A conflicting journal rejects Session access with a stable error.
      }
      void migrate().catch(() => {})
      try {
        for (const job of options.tasks?.().store.pendingPurges() ?? []) {
          const root = job.sessions[0]
          if (root) void finishPurge(root, job.sessions, job.id).catch(() => {})
        }
      } catch {
        /* A damaged task ledger does not remove any Session data. */
      }
    },
  }
}
