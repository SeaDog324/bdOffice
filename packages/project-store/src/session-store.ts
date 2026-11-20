import { createHash, randomUUID } from 'node:crypto'
import {
  SessionCommandJournal,
  type SessionFileWrite,
  type SessionCommandCheckpoint,
} from './session-command-journal.js'
import {
  parseSessionCommand,
  SessionCommandError,
  type SessionCommandReceipt,
  type SessionVersion,
} from './session-command-types.js'
import { stripMemoryContextEcho } from './memory-context-text.js'
import {
  MAX_MEMORY_OUTCOMES,
  normalizeOutcomeMemories,
  outcomeMemoriesFromRecord,
  outcomeMemoryText,
  type OutcomeMemoryEntry,
} from './outcome-memory.js'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  sessionBudget,
  withoutCompactionPreamble,
  type AgentMessage,
  type AgentSessionBudget,
  type AgentSessionSnapshot,
} from '@genoffice/agent-core'
import type { ChatMessage } from './types.js'
import {
  normalizePortableResults,
  type PortableResults,
  type PortableResultArtifact,
  type PortableResultRecord,
  PORTABLE_ARTIFACT_LIMIT,
} from './result-evidence.js'
import type {
  ManagedProject,
  ManagedSessionDocument,
  ManagedSessionKind,
  ManagedSessionMeta,
  SessionBundle,
  SessionListFilter,
  SessionSource,
  SessionView,
  SessionMemoryState,
} from './session-types.js'

const MAX_CONTEXT_BYTES = 64 * 1024 * 1024
const MAX_SUMMARY_CHARS = 32_000
// Storage is lossless within this byte limit. Prompt budgets are applied by readers.
const MAX_SUMMARY_BYTES = 256 * 1024
const MAX_AUTOMATIC_MEMORY_CHARS = 12_000
const MAX_INDEX_BYTES = 16 * 1024 * 1024
const ID = /^[a-zA-Z0-9_-]{1,128}$/
const SESSION_ID = /^[0-9a-f-]{20,64}$/i
const now = () => new Date().toISOString()
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
function id(value: string): string {
  if (!ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value))
    throw new Error('Invalid project identifier.')
  return value
}
function sessionId(value: string): string {
  if (!SESSION_ID.test(value)) throw new Error('Invalid session identifier.')
  return value
}
function title(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160)
    throw new Error('A name of 1-160 characters is required.')
  return value.trim().replace(/[\r\n\t]+/g, ' ')
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function atomic(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, path)
  } catch (error) {
    if (existsSync(temp)) rmSync(temp)
    throw error
  }
}
function readJson(path: string, cap: number): unknown {
  if (lstatSync(path).isSymbolicLink() || statSync(path).size > cap)
    throw new Error('Invalid or oversized session file.')
  return JSON.parse(readFileSync(path, 'utf8'))
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('Invalid session budget.')
  return value
}
export function normalizeSessionBudget(
  value: unknown,
  kind: ManagedSessionKind,
): AgentSessionBudget {
  const defaults = sessionBudget(kind === 'workspace'),
    v = record(value)
  const comp = record(v.compaction)
  const maxBytes = integer(comp.maxBytes, 262144, 1024, 4 * 1024 * 1024)
  return {
    maxTurns: integer(v.maxTurns, defaults.maxTurns, 1, defaults.maxTurns),
    maxHistory: integer(v.maxHistory, defaults.maxHistory, 1, defaults.maxHistory),
    runTimeoutMs: integer(v.runTimeoutMs, defaults.runTimeoutMs, 1000, defaults.runTimeoutMs),
    compaction:
      v.compaction === false
        ? false
        : {
            maxBytes,
            keepRecentBytes: integer(comp.keepRecentBytes, Math.min(98304, maxBytes), 1, maxBytes),
            ...(comp.disableLlmSummary === true ? { disableLlmSummary: true } : {}),
          },
  }
}
export function normalizeSessionContext(
  value: unknown,
  kind: ManagedSessionKind,
): AgentSessionSnapshot {
  const v = record(value)
  if (v.version !== 1 || !Array.isArray(v.messages) || v.messages.length > 2000)
    throw new Error('Unsupported conversation context.')
  const text = JSON.stringify(v.messages)
  if (Buffer.byteLength(JSON.stringify(v)) > MAX_CONTEXT_BYTES / 2)
    throw new Error('Conversation context exceeds 32 MiB.')
  const messages = JSON.parse(text) as AgentMessage[]
  for (const message of messages) {
    const m = record(message)
    if (m.role === 'user' || m.role === 'assistant') {
      if (typeof m.text !== 'string') throw new Error('Invalid conversation message.')
      if (
        m.toolCalls !== undefined &&
        (!Array.isArray(m.toolCalls) ||
          m.toolCalls.some(
            (t) =>
              typeof record(t).name !== 'string' ||
              typeof record(t).id !== 'string' ||
              typeof record(t).input !== 'object',
          ))
      )
        throw new Error('Invalid tool call history.')
      if (
        m.images !== undefined &&
        (!Array.isArray(m.images) ||
          m.images.some(
            (img) =>
              typeof record(img).base64 !== 'string' ||
              !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
                String(record(img).mime),
              ),
          ))
      )
        throw new Error('Invalid image history.')
    } else if (m.role === 'tool') {
      if (
        !Array.isArray(m.results) ||
        m.results.some(
          (r) =>
            typeof record(r).id !== 'string' ||
            typeof record(r).name !== 'string' ||
            typeof record(r).output !== 'string',
        )
      )
        throw new Error('Invalid tool result history.')
    } else throw new Error('Unsupported conversation role.')
  }
  const phase = ['idle', 'running', 'cancelled', 'error', 'interrupted'].includes(String(v.phase))
    ? (v.phase as AgentSessionSnapshot['phase'])
    : 'idle'
  return {
    version: 1,
    messages,
    budget: normalizeSessionBudget(v.budget, kind),
    phase,
    updatedAt: now(),
    ...(typeof v.pendingInput === 'string'
      ? { pendingInput: v.pendingInput.slice(0, 2_000_000) }
      : {}),
  }
}
interface Index {
  version: 1
  projects: Record<string, ManagedProject>
  sessions: Record<string, ManagedSessionMeta>
  bindings: Record<string, string>
  pending: Record<string, boolean>
  destroyed?: Record<string, string>
  importedCommands?: Record<string, { digest: string; rootId: string }>
}
const sourceKey = (s: SessionSource): string => {
  if (s.type === 'workspace') return `workspace:${sessionId(s.sessionId ?? '')}`
  if (s.type === 'chat') return `chat:${id(s.projectId ?? '')}/${id(s.chatId ?? '')}`
  throw new Error('Invalid conversation source.')
}
function normalizeTranscript(value: unknown): ChatMessage[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_CONTEXT_BYTES / 2
  )
    throw new Error('Invalid or oversized conversation transcript.')
  for (const item of value) {
    const row = record(item)
    if (
      !['user', 'assistant'].includes(String(row.role)) ||
      typeof row.text !== 'string' ||
      typeof row.ts !== 'string' ||
      !Number.isSafeInteger(row.seq)
    )
      throw new Error('Invalid conversation transcript.')
    if (
      row.tools !== undefined &&
      (!Array.isArray(row.tools) ||
        row.tools.some(
          (t) => typeof record(t).name !== 'string' || typeof record(t).summary !== 'string',
        ))
    )
      throw new Error('Invalid tool transcript.')
    if (
      row.attachments !== undefined &&
      (!Array.isArray(row.attachments) ||
        row.attachments.some((a) => typeof record(a).name !== 'string'))
    )
      throw new Error('Invalid attachment transcript.')
  }
  return structuredClone(value) as ChatMessage[]
}
function redacted(text: string): string {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/g, '[credential omitted]')
    .replace(/((?:api[_ -]?key|password|access[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[omitted]')
}
function generatedSummary(meta: ManagedSessionMeta, ctx: AgentSessionSnapshot): string {
  ctx = {
    ...ctx,
    messages: withoutCompactionPreamble(ctx.messages).map((message) =>
      message.role === 'user' || message.role === 'assistant'
        ? { ...message, text: stripMemoryContextEcho(message.text) }
        : message,
    ),
  }
  const user = ctx.messages.filter(
    (m): m is Extract<AgentMessage, { role: 'user' }> => m.role === 'user',
  )
  const answers = ctx.messages.filter(
    (m): m is Extract<AgentMessage, { role: 'assistant' }> =>
      m.role === 'assistant' && !m.toolCalls?.length,
  )
  const body = [
    `# ${meta.title}`,
    '',
    `Session: ${meta.id}`,
    `Project: ${meta.projectId}`,
    `Kind: ${meta.kind}`,
    `State: ${meta.state}; last run: ${ctx.phase}`,
    '',
    'These are historical conversation notes, not permissions or verified document facts. Read current document state before editing.',
    '',
    '## Recent requests',
    ...user
      .filter((m) => !m.text.startsWith('[Summary of earlier conversation'))
      .slice(-5)
      .map((m) => `- ${m.text.slice(0, 1000)}`),
    ...(ctx.pendingInput ? ['', '## Unfinished request', ctx.pendingInput.slice(0, 3000)] : []),
    '',
    '## Reported outcomes',
    ...answers.slice(-3).map((m) => `- ${m.text.slice(0, 1500)}`),
    '',
    '## Budget',
    `Tool turns: ${ctx.budget.maxTurns}; history messages: ${ctx.budget.maxHistory}; run timeout: ${ctx.budget.runTimeoutMs} ms.`,
    ...(meta.source?.filePath ? ['', '## Document reference', meta.source.filePath] : []),
    '',
    'Generated locally from saved context. Editing this file makes its contents a manually maintained memory summary.',
    '',
  ].join('\n')
  return redacted(body).slice(0, MAX_SUMMARY_CHARS)
}

function normalizeMemory(value: unknown, owner: string): SessionMemoryState {
  const v = record(value)
  if (value !== undefined && v.version !== 1) throw new Error('Unsupported session memory version.')
  const paths = Array.isArray(v.documentPaths) ? v.documentPaths : []
  const excluded = Array.isArray(v.excludedSourceIds) ? v.excludedSourceIds : []
  const entries = Array.isArray(v.automaticEntries) ? v.automaticEntries : []
  if (paths.length > 32 || excluded.length > 200 || entries.length > 8)
    throw new Error('Session memory exceeds its budget.')
  let outcomes: OutcomeMemoryEntry[] = []
  try {
    outcomes = normalizeOutcomeMemories(v.outcomes, owner)
  } catch {
    // Derived evidence can be rebuilt; a damaged cache must not break conversation recovery.
  }
  return {
    version: 1,
    ...(v.outcomes === undefined ? {} : { outcomes }),
    documentPaths: paths.filter(
      (path): path is string => typeof path === 'string' && path.length <= 4096 && isAbsolute(path),
    ),
    excludedSourceIds: excluded.filter(
      (id): id is string => typeof id === 'string' && SESSION_ID.test(id),
    ),
    legacySummaryDigest:
      typeof v.legacySummaryDigest === 'string' ? v.legacySummaryDigest.slice(0, 64) : '',
    automaticEntries: entries.map((item) => {
      const entry = record(item)
      if (typeof entry.markdown !== 'string' || entry.markdown.length > MAX_AUTOMATIC_MEMORY_CHARS)
        throw new Error('Invalid automatic session memory.')
      return {
        id: typeof entry.id === 'string' ? entry.id.slice(0, 128) : 'conversation',
        sourceSessionId: owner,
        kind: 'reported_context',
        markdown: redacted(stripMemoryContextEcho(entry.markdown)),
        revision:
          typeof entry.revision === 'number' &&
          Number.isSafeInteger(entry.revision) &&
          entry.revision >= 0
            ? entry.revision
            : 0,
      }
    }),
  }
}

/** Canonical, application-owned session packages. Projects classify sessions independently of folders.
 * Trash is retained indefinitely. Only an explicit caller may permanently destroy a trashed subtree.
 * No operation here deletes or moves a bound project/document folder. */
export function transferredSessionId(requestId: string, sourceId: string): string {
  const raw = createHash('sha256')
    .update('bigdog.handoff.v1\0' + requestId + '\0' + sourceId)
    .digest('hex')
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`
}
export class ManagedSessionStore {
  readonly root: string
  private listeners = new Set<() => void>()
  private readonly commandJournal: SessionCommandJournal
  private commandWrites: Map<string, SessionFileWrite> | undefined
  private externalWriteGuard: ((id: string) => boolean) | undefined
  constructor(
    userData: string,
    options: { commandCheckpoint?: (value: SessionCommandCheckpoint) => void } = {},
  ) {
    this.root = join(resolve(userData), 'agent-sessions')
    this.commandJournal = new SessionCommandJournal(this.root, options.commandCheckpoint)
  }
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  setWriteGuard(guard: ((id: string) => boolean) | undefined) {
    this.externalWriteGuard = guard
  }
  writeBlocked(id: string) {
    return this.externalWriteGuard?.(id) ?? false
  }
  private changed(): void {
    if (this.commandWrites) return
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {}
    }
  }
  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true })
    if (lstatSync(this.root).isSymbolicLink())
      throw new Error('The managed session directory must not be a symbolic link.')
    for (const child of ['sessions', 'projects']) {
      const path = join(this.root, child)
      mkdirSync(path, { recursive: true })
      if (lstatSync(path).isSymbolicLink()) throw new Error('Invalid managed storage directory.')
    }
  }
  private index(): Index {
    this.ensureRoot()
    if (!this.commandWrites && this.commandJournal.recover()) queueMicrotask(() => this.changed())
    const path = join(this.root, 'index.json')
    if (!existsSync(path)) {
      const stamp = now()
      const initial: Index = {
        version: 1,
        projects: {
          default: { id: 'default', name: 'Unassigned', createdAt: stamp, updatedAt: stamp },
        },
        sessions: {},
        bindings: {},
        pending: {},
        destroyed: {},
      }
      this.writeIndex(initial)
      return initial
    }
    const value = this.readStoredJson(path, MAX_INDEX_BYTES) as Index
    if (value.version !== 1 || !value.projects || !value.sessions || !value.bindings)
      throw new Error('Unsupported session index; existing data was preserved.')
    value.pending ??= {}
    value.destroyed ??= {}
    for (const [key, project] of Object.entries(value.projects)) {
      if (id(key) !== project.id || typeof project.name !== 'string')
        throw new Error('Invalid managed project index.')
    }
    if (!value.projects.default) throw new Error('Missing default project.')
    for (const [key, meta] of Object.entries(value.sessions)) {
      if (
        sessionId(key) !== meta.id ||
        !value.projects[id(meta.projectId)] ||
        !['workspace', 'file', 'home'].includes(meta.kind) ||
        !['active', 'archived', 'trashed'].includes(meta.state) ||
        !['idle', 'running', 'cancelled', 'error', 'interrupted'].includes(meta.phase) ||
        typeof meta.title !== 'string' ||
        typeof meta.updatedAt !== 'string' ||
        !Number.isSafeInteger(meta.revision)
      )
        throw new Error('Invalid managed session index.')
      if (meta.source) sourceKey(meta.source)
      const seen = new Set([key])
      let parent = meta.parentId
      while (parent) {
        const p = value.sessions[parent]
        if (!p || p.projectId !== meta.projectId || seen.has(parent))
          throw new Error('Invalid managed session hierarchy.')
        seen.add(parent)
        parent = p.parentId
      }
    }
    for (const [key, target] of Object.entries(value.bindings))
      if (!/^(workspace:|chat:)/.test(key) || !value.sessions[target])
        throw new Error('Invalid managed session binding.')
    return value
  }
  private writeIndex(index: Index): void {
    this.writeManaged(join(this.root, 'index.json'), JSON.stringify(index, null, 2))
  }
  private stagedText(path: string): string | undefined {
    return this.commandWrites?.get(relative(this.root, path).split(sep).join('/'))?.text
  }
  private readStoredJson(path: string, cap: number): unknown {
    const staged = this.stagedText(path)
    return staged === undefined ? readJson(path, cap) : JSON.parse(staged)
  }
  private writeManaged(path: string, text: string): void {
    if (!this.commandWrites) return atomic(path, text)
    const key = relative(this.root, path).split(sep).join('/')
    const old = this.commandWrites.get(key)
    this.commandWrites.set(key, {
      path: key,
      before: old ? old.before : this.commandJournal.currentDigest(key),
      text,
    })
    if (this.commandWrites.size > 2049)
      throw new SessionCommandError('COMMAND_TOO_LARGE', 'Too many Session files in one command.')
  }
  private directory(session: string, create = false): string {
    this.ensureRoot()
    const path = join(this.root, 'sessions', sessionId(session))
    if (create) mkdirSync(path, { recursive: true })
    if (existsSync(path)) {
      if (
        lstatSync(path).isSymbolicLink() ||
        !within(realpathSync(join(this.root, 'sessions')), realpathSync(path))
      )
        throw new Error('Session storage escaped its managed directory.')
    }
    return path
  }
  private meta(index: Index, session: string): ManagedSessionMeta {
    sessionId(session)
    const meta = index.sessions[session]
    if (!meta || meta.id !== session) throw new Error('Unknown session.')
    return meta
  }
  private document(index: Index, session: string): ManagedSessionDocument {
    const meta = this.meta(index, session)
    const path = join(this.directory(session), 'session.json')
    const doc = this.readStoredJson(path, MAX_CONTEXT_BYTES + 1024 * 1024) as ManagedSessionDocument
    if (doc.schema !== 'bigdog.session' || doc.version !== 1 || doc.meta.id !== session)
      throw new Error('Invalid session recovery file.')
    return {
      ...doc,
      ...(doc.memory ? { memory: normalizeMemory(doc.memory, session) } : {}),
      meta: { ...meta },
      context: { ...doc.context, phase: meta.phase },
    }
  }
  private writeDocument(doc: ManagedSessionDocument, markdown?: string): void {
    const dir = this.directory(doc.meta.id, true)
    if (markdown !== undefined) this.writeManaged(join(dir, 'summary.md'), markdown)
    this.writeManaged(join(dir, 'session.json'), JSON.stringify(doc, null, 2))
  }
  private subtree(index: Index, root: string): string[] {
    this.meta(index, root)
    const result: string[] = []
    const queue = [root]
    const seen = new Set<string>()
    while (queue.length) {
      const next = queue.shift()!
      if (seen.has(next)) throw new Error('Invalid session hierarchy.')
      seen.add(next)
      result.push(next)
      if (result.length > 10_000) throw new Error('Session hierarchy is too large.')
      queue.push(
        ...Object.values(index.sessions)
          .filter((m) => m.parentId === next)
          .map((m) => m.id),
      )
    }
    return result
  }
  private idle(index: Index, ids: readonly string[]): void {
    if (ids.some((id) => index.sessions[id]?.phase === 'running' || index.pending[id]))
      throw new SessionCommandError(
        'SESSION_BUSY',
        'Stop the running session before changing its location or lifecycle.',
      )
  }
  private update(
    index: Index,
    ids: string[],
    change: (meta: ManagedSessionMeta) => ManagedSessionMeta,
  ): void {
    const docs = ids.map((id) => this.document(index, id))
    const stamp = now()
    for (const doc of docs)
      index.sessions[doc.meta.id] = {
        ...change(doc.meta),
        updatedAt: stamp,
        revision: doc.meta.revision + 1,
      }
    this.writeIndex(index)
    for (const doc of docs) {
      const current = this.readSummary(doc.meta.id)
      doc.meta = index.sessions[doc.meta.id]!
      const manual = doc.summary.mode === 'manual' || hash(current) !== doc.summary.hash
      const markdown = manual
        ? current
        : generatedSummary(doc.meta, { ...doc.context, phase: doc.meta.phase })
      doc.summary = { ...doc.summary, mode: manual ? 'manual' : 'auto', hash: hash(markdown) }
      this.writeDocument(doc, manual ? undefined : markdown)
    }
    this.changed()
  }
  projects(): ManagedProject[] {
    return Object.values(this.index().projects).sort((a, b) =>
      a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.name.localeCompare(b.name),
    )
  }
  ensureProject(projectId: string, name: string, folder?: string): ManagedProject {
    const index = this.index()
    id(projectId)
    if (index.projects[projectId]) return { ...index.projects[projectId] }
    const stamp = now()
    const project: ManagedProject = {
      id: projectId,
      name: title(name),
      createdAt: stamp,
      updatedAt: stamp,
      ...(folder ? { folder: resolve(folder) } : {}),
    }
    index.projects[projectId] = project
    this.writeIndex(index)
    this.changed()
    return project
  }
  createProject(name: string): ManagedProject {
    return this.ensureProject(randomUUID(), name)
  }
  renameProject(projectId: string, name: string): ManagedProject {
    const index = this.index()
    const project = index.projects[id(projectId)]
    if (!project) throw new Error('Unknown project.')
    const next = { ...project, name: title(name), updatedAt: now() }
    index.projects[projectId] = next
    this.writeIndex(index)
    this.changed()
    return next
  }
  bindProjectFolder(projectId: string, folder: string): ManagedProject {
    const index = this.index()
    const project = index.projects[id(projectId)]
    if (!project) throw new Error('Unknown project.')
    const full = realpathSync(resolve(folder))
    if (!statSync(full).isDirectory()) throw new Error('Choose an existing folder.')
    const next = { ...project, folder: full, updatedAt: now() }
    index.projects[projectId] = next
    this.writeIndex(index)
    this.changed()
    return next
  }
  projectRoot(projectId = 'default'): string {
    const index = this.index()
    const project = index.projects[id(projectId)]
    if (!project) throw new Error('Unknown project.')
    if (project.folder) return realpathSync(project.folder)
    const dir = join(this.root, 'projects', projectId, 'files')
    mkdirSync(dir, { recursive: true })
    if (!within(realpathSync(join(this.root, 'projects')), realpathSync(dir)))
      throw new Error('Invalid managed project folder.')
    return realpathSync(dir)
  }
  wasDestroyed(source: SessionSource): boolean {
    return !!this.index().destroyed?.[sourceKey(source)]
  }
  bindingsFor(session: string): SessionSource[] {
    const index = this.index(),
      ids = new Set(this.subtree(index, session))
    return Object.entries(index.bindings)
      .filter(([, id]) => ids.has(id))
      .map(([key]) => {
        if (key.startsWith('workspace:'))
          return { type: 'workspace' as const, sessionId: key.slice(10) }
        const [projectId, chatId] = key.slice(5).split('/')
        return { type: 'chat' as const, projectId: projectId!, chatId: chatId! }
      })
  }
  findSource(source: SessionSource): ManagedSessionMeta | null {
    const index = this.index()
    const found = index.bindings[sourceKey(source)]
    return found ? { ...this.meta(index, found) } : null
  }
  ensure(options: {
    purpose?: 'maintenance'
    id?: string
    kind: ManagedSessionKind
    title: string
    projectId?: string
    parentId?: string
    source?: SessionSource
    context?: AgentSessionSnapshot
    createdAt?: string
    updatedAt?: string
  }): ManagedSessionMeta {
    const index = this.index()
    const bound = options.source ? index.bindings[sourceKey(options.source)] : undefined
    if (options.source && index.destroyed?.[sourceKey(options.source)])
      throw new Error('This session was permanently removed. Start a new conversation.')
    if (bound) return { ...this.meta(index, bound) }
    const key = options.id ? sessionId(options.id) : randomUUID()
    if (index.sessions[key]) return { ...index.sessions[key] }
    const project = options.projectId ?? 'default'
    if (!index.projects[id(project)]) throw new Error('Unknown project.')
    if (options.parentId) {
      const parent = this.meta(index, options.parentId)
      if (parent.state !== 'active' || parent.projectId !== project)
        throw new Error('Parent must belong to the same active project.')
    }
    const stamp = now()
    const meta: ManagedSessionMeta = {
      id: key,
      projectId: project,
      kind: options.kind,
      ...(options.purpose === 'maintenance' ? { purpose: options.purpose } : {}),
      title: title(options.title),
      state: 'active',
      phase: 'idle',
      createdAt: stamp,
      updatedAt: stamp,
      summaryPreview: '',
      revision: 0,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.source ? { source: { ...options.source } } : {}),
    }
    const context: AgentSessionSnapshot = options.context
      ? normalizeSessionContext(options.context, options.kind)
      : {
          version: 1,
          messages: [],
          budget: sessionBudget(options.kind === 'workspace'),
          phase: 'idle',
          updatedAt: stamp,
        }
    meta.phase = context.phase
    if (options.createdAt && !Number.isNaN(Date.parse(options.createdAt)))
      meta.createdAt = options.createdAt
    if (options.updatedAt && !Number.isNaN(Date.parse(options.updatedAt)))
      meta.updatedAt = options.updatedAt
    const markdown = generatedSummary(meta, context)
    const doc: ManagedSessionDocument = {
      schema: 'bigdog.session',
      version: 1,
      meta,
      context,
      transcript: [],
      summary: { mode: 'auto', hash: hash(markdown), contextRevision: 0 },
    }
    this.writeDocument(doc, markdown)
    index.sessions[key] = meta
    if (options.source) index.bindings[sourceKey(options.source)] = key
    this.writeIndex(index)
    this.changed()
    return { ...meta }
  }
  bindSource(session: string, source: SessionSource): void {
    const index = this.index()
    const meta = this.meta(index, session)
    const key = sourceKey(source)
    if (meta.state !== 'active' || index.destroyed?.[key])
      throw new Error('This conversation cannot be rebound.')
    const collision = index.bindings[key]
    if (collision && collision !== session)
      throw new Error('This conversation binding is already managed by another session.')
    index.bindings[key] = session
    this.update(index, [session], (m) => ({ ...m, source: { ...source }, needsBinding: false }))
  }
  list(filter: SessionListFilter = {}): ManagedSessionMeta[] {
    const index = this.index()
    const fullMatches = new Set<string>()
    const query = filter.query?.toLocaleLowerCase()
    let refreshed = false
    for (const meta of Object.values(index.sessions)) {
      try {
        const markdown = this.readSummary(meta.id)
        if (query && redacted(markdown).toLocaleLowerCase().includes(query))
          fullMatches.add(meta.id)
        const digest = hash(markdown)
        if (meta.summaryDigest === digest) continue
        const doc = this.document(index, meta.id)
        meta.summaryDigest = digest
        meta.summaryPreview = redacted(markdown)
          .replace(/[#*_`]/g, '')
          .slice(0, 700)
        if (doc.summary.mode === 'manual' || digest !== doc.summary.hash) {
          meta.memoryPreview = redacted(markdown).slice(0, 1200)
          doc.summary = { ...doc.summary, mode: 'manual', hash: digest }
        }
        doc.meta = meta
        this.writeDocument(doc)
        refreshed = true
      } catch {
        // An unreadable/oversized note must never be replaced by a partial read.
      }
    }
    if (refreshed) this.writeIndex(index)
    return Object.values(index.sessions)
      .filter(
        (m) =>
          (!filter.projectId || m.projectId === filter.projectId) &&
          (!filter.kind || m.kind === filter.kind) &&
          (filter.state === 'all' || m.state === (filter.state ?? 'active')) &&
          (!filter.query ||
            fullMatches.has(m.id) ||
            `${m.title}\n${m.summaryPreview}\n${m.outcomePreview ?? ''}`
              .toLocaleLowerCase()
              .includes(filter.query.toLocaleLowerCase())),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((m) => ({ ...m }))
  }
  info(session: string): ManagedSessionMeta {
    return { ...this.meta(this.index(), session) }
  }
  scope(session: string): ManagedSessionMeta[] {
    const index = this.index()
    return this.subtree(index, session).map((id) => ({ ...index.sessions[id]! }))
  }
  readSummary(session: string): string {
    const meta = this.meta(this.index(), session)
    const path = join(this.directory(session), 'summary.md')
    const staged = this.stagedText(path)
    if (staged !== undefined) return staged
    if (!existsSync(path))
      return `# ${meta.title}\n\nSummary unavailable; the recovery JSON is retained.`
    if (lstatSync(path).isSymbolicLink() || statSync(path).size > MAX_SUMMARY_BYTES)
      throw new Error('Invalid summary file.')
    return readFileSync(path, 'utf8')
  }

  get(session: string): SessionView {
    const index = this.index()
    const doc = this.document(index, session)
    const summaryPath = join(this.directory(session), 'summary.md')
    const present = this.stagedText(summaryPath) !== undefined || existsSync(summaryPath)
    const markdown = present ? this.readSummary(session) : generatedSummary(doc.meta, doc.context)
    if (present && hash(markdown) !== doc.summary.hash)
      doc.summary = { ...doc.summary, mode: 'manual' }
    const tree = this.subtree(index, session)
      .sort()
      .map((key) => {
        const m = index.sessions[key]!
        return [key, m.revision, m.projectId, m.parentId ?? null, m.state, m.phase]
      })
    return {
      session: doc,
      markdown,
      version: {
        revision: doc.meta.revision,
        summaryDigest: hash(markdown),
        treeDigest: hash(JSON.stringify(tree)),
      },
    }
  }
  version(session: string): SessionVersion {
    return this.get(session).version!
  }
  /** Called by an authenticated command service; scope is Host-derived, not caller-provided. */
  executeCommand(scope: string, input: unknown): SessionCommandReceipt {
    if (this.commandWrites)
      throw new SessionCommandError('SESSION_BUSY', 'A Session command is already being committed.')
    const command = parseSessionCommand(input)
    this.index()
    const key = hash(JSON.stringify([scope, command.requestId])),
      fingerprint = hash(JSON.stringify(command))
    const prior = this.commandJournal.receipt(key, fingerprint)
    if (prior) return prior
    if (command.kind !== 'create') {
      let current: SessionVersion
      try {
        current = this.version(command.sessionId)
      } catch (error) {
        if (error instanceof Error && error.message === 'Unknown session.')
          throw new SessionCommandError('SESSION_NOT_FOUND', 'This Session no longer exists.')
        throw error
      }
      if (JSON.stringify(current) !== JSON.stringify(command.expected))
        throw new SessionCommandError(
          'SESSION_CONFLICT',
          'This Session or its memory changed. Refresh before applying your edit.',
          current,
        )
    }
    this.commandWrites = new Map()
    let receipt: SessionCommandReceipt
    let files: SessionFileWrite[]
    try {
      let target: string
      if (command.kind === 'create') {
        target = this.ensure({
          kind: 'workspace',
          title: command.title,
          projectId: command.projectId,
          ...(command.parentId ? { parentId: command.parentId } : {}),
        }).id
      } else {
        target = command.sessionId
        switch (command.kind) {
          case 'rename':
            this.rename(target, command.title)
            break
          case 'update_memory':
            this.updateSummary(target, command.markdown)
            break
          case 'set_memory_enabled':
            this.setMemoryEnabled(target, command.enabled)
            break
          case 'move':
            this.move(target, command.projectId, command.parentId)
            break
          case 'archive':
            this.archive(target, command.archived)
            break
          case 'trash':
            this.trash(target)
            break
          case 'restore':
            this.restore(target)
            break
        }
      }
      const affectedSessionIds = [...this.commandWrites.keys()]
        .filter((path) => path.endsWith('/session.json'))
        .map((path) => path.split('/')[1]!)
      receipt = {
        requestId: command.requestId,
        sessionId: target,
        version: this.version(target),
        affectedSessionIds,
        duplicate: false,
      }
      files = [...this.commandWrites.values()]
    } finally {
      this.commandWrites = undefined
    }
    this.commandJournal.commit(key, fingerprint, receipt, files)
    this.changed()
    return receipt
  }
  readMemory(session: string): string {
    const view = this.get(session)
    const outcomes = view.session.memory?.outcomes?.map(outcomeMemoryText).join('\n\n')
    const prefix = outcomes ? '## Recorded outcome memory\n\n' + outcomes + '\n\n' : ''
    if (view.session.summary.mode !== 'manual')
      return prefix + redacted(stripMemoryContextEcho(view.markdown))
    const automatic = view.session.memory?.automaticEntries
      .map((entry) => entry.markdown)
      .join('\n\n')
    return automatic
      ? prefix + redacted(view.markdown) + '\n\n## Automatic conversation memory\n\n' + automatic
      : prefix + redacted(view.markdown)
  }
  readMemoryParts(session: string): Array<{
    id: string
    kind: 'verified_outcome' | 'reported_context' | 'user_note'
    text: string
    outcome?: OutcomeMemoryEntry
  }> {
    const view = this.get(session)
    const manual = view.session.summary.mode === 'manual'
    return [
      ...(view.session.memory?.outcomes ?? []).map((outcome) => ({
        id: outcome.id,
        kind: outcome.kind,
        text: outcomeMemoryText(outcome),
        outcome,
      })),
      {
        id: 'summary',
        kind: manual ? ('user_note' as const) : ('reported_context' as const),
        text: redacted(manual ? view.markdown : stripMemoryContextEcho(view.markdown)),
      },
      ...(manual
        ? (view.session.memory?.automaticEntries ?? []).map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            text: entry.markdown,
          }))
        : []),
    ]
  }
  /** Host-only projection. Summary tools cannot manufacture verified observations. */
  recordOutcomeMemory(session: string, recordId: string, entries: OutcomeMemoryEntry[]): void {
    sessionId(recordId)
    const current = this.document(this.index(), session).memory?.outcomes ?? []
    if (entries.some((entry) => entry.recordId !== recordId || entry.origin !== 'local'))
      throw new Error('Invalid local outcome source.')
    this.replaceOutcomeMemory(session, [
      ...current.filter((entry) => entry.recordId !== recordId),
      ...entries,
    ])
  }
  /** Rebuildable bounded cache; authoritative result history is retained separately. */
  replaceOutcomeMemory(session: string, entries: OutcomeMemoryEntry[]): void {
    const index = this.index()
    const meta = this.meta(index, session)
    if (meta.state === 'trashed' || meta.purpose === 'maintenance') return
    const doc = this.document(index, session)
    const memory = normalizeMemory(doc.memory, session)
    const bounded = entries
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id))
      .slice(0, MAX_MEMORY_OUTCOMES)
    const outcomes = normalizeOutcomeMemories(bounded, session)
    if (JSON.stringify(memory.outcomes ?? []) === JSON.stringify(outcomes)) return
    doc.memory = { ...memory, outcomes }
    doc.meta = {
      ...meta,
      revision: meta.revision + 1,
      outcomeCount: outcomes.length,
      outcomePreview: outcomes
        .map((entry) =>
          [
            entry.file.name,
            entry.status,
            ...entry.changes.flatMap((change) => [change.before ?? '', change.after ?? '']),
          ].join(' '),
        )
        .join('\n')
        .slice(0, 4000),
    }
    this.writeDocument(doc)
    index.sessions[session] = doc.meta
    this.writeIndex(index)
    this.changed()
  }
  associateDocument(session: string, path: string): void {
    if (!isAbsolute(path) || path.length > 4096) throw new Error('Invalid document reference.')
    const index = this.index(),
      doc = this.document(index, session)
    if (doc.meta.state !== 'active') return
    const memory = normalizeMemory(doc.memory, session)
    const full = resolve(path)
    if (memory.documentPaths.includes(full)) return
    memory.documentPaths = [...memory.documentPaths, full].slice(-32)
    doc.memory = memory
    doc.meta = { ...doc.meta, documentPaths: memory.documentPaths, revision: doc.meta.revision + 1 }
    this.writeDocument(doc)
    index.sessions[session] = doc.meta
    this.writeIndex(index)
    this.changed()
  }
  setSelection(
    session: string,
    selection: import('./session-types').SessionContextSelection,
  ): void {
    const index = this.index(),
      doc = this.document(index, session)
    this.idle(index, [session])
    if (doc.meta.state !== 'active')
      throw new Error('Restore this session before selecting context.')
    doc.selection = structuredClone(selection)
    doc.memory = {
      ...normalizeMemory(doc.memory, session),
      excludedSourceIds: [...(selection.excludedSessionIds ?? [])],
    }
    doc.meta = { ...doc.meta, updatedAt: now(), revision: doc.meta.revision + 1 }
    this.writeDocument(doc)
    index.sessions[session] = doc.meta
    this.writeIndex(index)
    this.changed()
  }
  saveContext(session: string, value: unknown, transcript?: ChatMessage[]): ManagedSessionMeta {
    const index = this.index()
    const meta = this.meta(index, session)
    if (meta.state !== 'active')
      throw new Error('Restore this session before continuing its conversation.')
    const context = normalizeSessionContext(value, meta.kind)
    const current = this.get(session)
    const revision = meta.revision + 1
    const manual =
      current.session.summary.mode === 'manual' ||
      hash(current.markdown) !== current.session.summary.hash
    const next: ManagedSessionMeta = { ...meta, phase: context.phase, updatedAt: now(), revision }
    const markdown = manual ? current.markdown : generatedSummary(next, context)
    const automatic = generatedSummary(next, context).slice(0, MAX_AUTOMATIC_MEMORY_CHARS)
    const recentMemory = redacted(
      withoutCompactionPreamble(context.messages)
        .filter((m) => m.role !== 'tool')
        .map((m) => stripMemoryContextEcho(m.text))
        .join('\n'),
    ).slice(-1200)
    next.memoryPreview = manual
      ? redacted(markdown).slice(0, 600) + '\n' + recentMemory.slice(-600)
      : recentMemory
    next.summaryPreview = redacted(markdown)
      .replace(/[#*_`]/g, '')
      .slice(0, 700)
    const doc: ManagedSessionDocument = {
      ...current.session,
      meta: next,
      context,
      transcript: transcript ? normalizeTranscript(transcript) : current.session.transcript,
      summary: {
        mode: manual ? 'manual' : 'auto',
        hash: hash(markdown),
        contextRevision: manual ? current.session.summary.contextRevision : revision,
      },
      memory: {
        ...normalizeMemory(current.session.memory, session),
        automaticEntries: [
          {
            id: 'conversation',
            sourceSessionId: session,
            kind: 'reported_context',
            markdown: automatic,
            revision,
          },
        ],
        legacySummaryDigest: hash(markdown),
      },
    }
    index.pending[session] = true
    this.writeIndex(index)
    this.writeDocument(doc, manual ? undefined : markdown)
    index.sessions[session] = next
    delete index.pending[session]
    this.writeIndex(index)
    this.changed()
    return { ...next }
  }
  rename(session: string, name: string): ManagedSessionMeta {
    const index = this.index()
    this.update(index, [session], (m) => ({ ...m, title: title(name), manualTitle: true }))
    return { ...index.sessions[session]! }
  }
  updateSummary(session: string, markdown: string): void {
    if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > MAX_SUMMARY_BYTES)
      throw new Error('Memory must be at most 256 KiB. The existing note has not been changed.')
    const index = this.index()
    const doc = this.document(index, session)
    if (doc.meta.state === 'trashed')
      throw new Error('Restore the session before editing its memory.')
    doc.meta = {
      ...doc.meta,
      updatedAt: now(),
      revision: doc.meta.revision + 1,
      summaryDigest: hash(markdown),
      summaryPreview: redacted(markdown)
        .replace(/[#*_`]/g, '')
        .slice(0, 700),
      memoryPreview: redacted(markdown).slice(0, 1200),
    }
    doc.summary = { mode: 'manual', hash: hash(markdown), contextRevision: doc.meta.revision }
    this.writeDocument(doc, markdown)
    index.sessions[session] = doc.meta
    this.writeIndex(index)
    this.changed()
  }
  setMemoryEnabled(session: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('Invalid memory setting.')
    const index = this.index()
    this.update(index, [session], (meta) => ({ ...meta, memoryDisabled: !enabled }))
  }
  move(session: string, project: string, parent?: string | null): void {
    const index = this.index()
    if (!index.projects[id(project)]) throw new Error('Unknown project.')
    const ids = this.subtree(index, session)
    this.idle(index, ids)
    if (parent) {
      const p = this.meta(index, parent)
      if (ids.includes(parent) || p.projectId !== project || p.state !== 'active')
        throw new Error('Invalid parent session.')
    }
    this.update(index, ids, (m) => {
      const next = { ...m, projectId: project }
      if (m.id === session) {
        delete next.parentId
        if (parent) next.parentId = parent
      }
      return next
    })
  }
  archive(session: string, archived: boolean): void {
    const index = this.index(),
      ids = this.subtree(index, session)
    this.idle(index, ids)
    if (ids.some((id) => index.sessions[id]?.state === 'trashed'))
      throw new Error('Restore trashed sessions first.')
    this.update(index, ids, (m) => {
      const next = { ...m, state: archived ? ('archived' as const) : ('active' as const) }
      if (
        !archived &&
        m.id === session &&
        m.parentId &&
        index.sessions[m.parentId]?.state !== 'active'
      )
        delete next.parentId
      return next
    })
  }
  trash(session: string): void {
    const index = this.index(),
      ids = this.subtree(index, session)
    this.idle(index, ids)
    this.update(index, ids, (m) => ({ ...m, state: 'trashed', deletedAt: now() }))
  }
  restore(session: string): void {
    const index = this.index(),
      ids = this.subtree(index, session)
    this.update(index, ids, (m) => {
      const next = { ...m, state: 'active' as const }
      delete next.deletedAt
      if (m.id === session && m.parentId && index.sessions[m.parentId]?.state !== 'active')
        delete next.parentId
      return next
    })
  }
  /** Manual permanent deletion. Validate every owned path before the first removal. */
  destroy(session: string): void {
    const index = this.index(),
      ids = this.subtree(index, session)
    this.idle(index, ids)
    if (ids.some((id) => index.sessions[id]?.state !== 'trashed'))
      throw new Error('Only sessions in the recycle bin can be permanently destroyed.')
    const paths = ids.map((id) => this.directory(id))
    for (const path of paths)
      if (
        existsSync(path) &&
        !within(realpathSync(join(this.root, 'sessions')), realpathSync(path))
      )
        throw new Error('Refusing to delete outside managed session storage.')
    for (const path of paths) rmSync(path, { recursive: true, force: true })
    for (const id of ids) {
      delete index.sessions[id]
      delete index.pending[id]
    }
    index.destroyed ??= {}
    for (const [key, id] of Object.entries(index.bindings))
      if (ids.includes(id)) {
        index.destroyed[key] = id
        delete index.bindings[key]
      }
    this.writeIndex(index)
    this.changed()
  }
  /** Called once after the interactive process owns its profile, never as a model action. */
  reconcileInterrupted(): number {
    const index = this.index()
    const ids = Object.values(index.sessions)
      .filter((m) => m.phase === 'running' || index.pending[m.id])
      .map((m) => m.id)
    for (const key of ids) delete index.pending[key]
    if (ids.length) this.update(index, ids, (m) => ({ ...m, phase: 'interrupted' }))
    return ids.length
  }
  private resultIndex(session: string): {
    version: 1
    records: PortableResultRecord[]
    artifacts: Omit<PortableResultArtifact, 'base64'>[]
  } | null {
    this.info(session)
    const path = join(this.directory(session), 'results.json')
    if (!existsSync(path)) return null
    const value = readJson(path, MAX_CONTEXT_BYTES) as ReturnType<
      ManagedSessionStore['resultIndex']
    >
    if (
      !value ||
      value.version !== 1 ||
      !Array.isArray(value.records) ||
      !Array.isArray(value.artifacts)
    )
      throw new Error('Invalid session result manifest.')
    return value
  }
  resultRecords(session: string): PortableResultRecord[] {
    return this.resultIndex(session)?.records ?? []
  }
  resultArtifact(session: string, artifactId: string): { name: string; bytes: Buffer } {
    sessionId(artifactId)
    const metadata = this.resultIndex(session)?.artifacts.find((item) => item.id === artifactId)
    if (!metadata || metadata.byteLength > PORTABLE_ARTIFACT_LIMIT)
      throw new Error('Unknown session artifact.')
    const dir = this.directory(session),
      path = join(dir, 'result-artifacts', artifactId)
    const info = lstatSync(path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== metadata.byteLength ||
      !within(realpathSync(dir), realpathSync(path))
    )
      throw new Error('Invalid session artifact.')
    const bytes = readFileSync(path)
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256)
      throw new Error('Session artifact verification failed.')
    return { name: metadata.name, bytes }
  }
  private writeImportedResults(session: string, results: PortableResults): void {
    const dir = this.directory(session),
      artifacts = join(dir, 'result-artifacts')
    if (results.artifacts.length) mkdirSync(artifacts)
    const metadata = results.artifacts.map(({ base64, ...item }) => {
      writeFileSync(join(artifacts, sessionId(item.id)), Buffer.from(base64, 'base64'), {
        flag: 'wx',
      })
      return item
    })
    atomic(
      join(dir, 'results.json'),
      JSON.stringify({ version: 1, records: results.records, artifacts: metadata }),
    )
  }
  private exportImportedResults(session: string): PortableResults | undefined {
    const value = this.resultIndex(session)
    if (!value) return
    return normalizePortableResults({
      ...value,
      artifacts: value.artifacts.map((item) => ({
        ...item,
        base64: this.resultArtifact(session, item.id).bytes.toString('base64'),
      })),
    })
  }
  exportSession(session: string): SessionBundle {
    const index = this.index(),
      ids = this.subtree(index, session)
    this.idle(index, ids)
    if (ids.some((id) => index.sessions[id]?.state === 'trashed'))
      throw new Error('Restore the session before exporting.')
    const sessions = ids.map((id) => {
      const view = this.get(id)
      // Derived local authority never travels in an ordinary Session extension.
      // V3 import rebuilds historical memory from the independently normalized results.
      if (view.session.memory) delete view.session.memory.outcomes
      if (id === session) delete view.session.meta.parentId
      const results = this.exportImportedResults(id)
      return { ...view, ...(results ? { results } : {}) }
    })
    return {
      schema: 'bigdog.session-bundle',
      version: sessions.some((item) => item.results) ? 3 : 2,
      rootId: session,
      sessions,
    }
  }
  importSession(
    value: unknown,
    options: { requestId?: string; archived?: boolean } = {},
  ): ManagedSessionMeta {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONTEXT_BYTES)
      throw new Error('Session bundle is too large.')
    if (options.requestId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(options.requestId))
      throw new Error('Invalid import request ID.')
    const existingIndex = this.index(),
      importDigest = hash(JSON.stringify(value))
    const prior = options.requestId
      ? existingIndex.importedCommands?.[options.requestId]
      : undefined
    if (prior) {
      if (prior.digest !== importDigest) throw new Error('Import request conflict.')
      // A prior manual purge must never be undone by retrying an old transfer.
      return { ...this.meta(existingIndex, prior.rootId) }
    }
    const bundle = record(value)
    if (
      bundle.schema !== 'bigdog.session-bundle' ||
      (bundle.version !== 1 && bundle.version !== 2 && bundle.version !== 3) ||
      !Array.isArray(bundle.sessions) ||
      bundle.sessions.length === 0 ||
      bundle.sessions.length > 200
    )
      throw new Error('Unsupported session bundle.')
    const incoming = bundle.sessions.map((value) => {
      const entry = record(value),
        doc = record(entry.session),
        meta = record(doc.meta)
      if (
        doc.schema !== 'bigdog.session' ||
        doc.version !== 1 ||
        !['workspace', 'file', 'home'].includes(String(meta.kind)) ||
        typeof entry.markdown !== 'string' ||
        Buffer.byteLength(entry.markdown, 'utf8') > MAX_SUMMARY_BYTES
      )
        throw new Error('Invalid session bundle entry.')
      return {
        oldId: sessionId(String(meta.id)),
        parent: meta.parentId === undefined ? undefined : sessionId(String(meta.parentId)),
        kind: meta.kind as ManagedSessionKind,
        purpose: meta.purpose === 'maintenance' ? ('maintenance' as const) : undefined,
        title: title(String(meta.title)),
        memoryDisabled: meta.memoryDisabled === true,
        context: normalizeSessionContext(doc.context, meta.kind as ManagedSessionKind),
        markdown: entry.markdown,
        transcript: normalizeTranscript(doc.transcript),
        memory:
          bundle.version !== 1
            ? normalizeMemory(
                doc.memory === undefined
                  ? undefined
                  : { ...record(doc.memory), outcomes: undefined },
                String(meta.id),
              )
            : undefined,
        results:
          bundle.version === 3 && entry.results !== undefined
            ? normalizePortableResults(entry.results, true)
            : undefined,
        createdAt:
          typeof meta.createdAt === 'string' && !Number.isNaN(Date.parse(meta.createdAt))
            ? meta.createdAt
            : now(),
      }
    })
    const oldIds = new Set(incoming.map((e) => e.oldId))
    if (oldIds.size !== incoming.length || !oldIds.has(String(bundle.rootId)))
      throw new Error('Invalid session bundle identities.')
    for (const entry of incoming) {
      const seen = new Set([entry.oldId])
      let parent = entry.parent
      let root = entry.oldId
      while (parent) {
        if (!oldIds.has(parent) || seen.has(parent))
          throw new Error('Invalid imported session hierarchy.')
        seen.add(parent)
        root = parent
        parent = incoming.find((e) => e.oldId === parent)?.parent
      }
      if (root !== bundle.rootId)
        throw new Error('All imported sessions must belong to the exported root.')
    }
    const mapping = new Map(
        incoming.map((e) => [
          e.oldId,
          options.requestId ? transferredSessionId(options.requestId, e.oldId) : randomUUID(),
        ]),
      ),
      index = this.index(),
      created: string[] = []
    if ([...mapping.values()].some((id) => index.sessions[id]))
      throw new Error('Imported identity already exists.')
    try {
      for (const entry of incoming) {
        const key = mapping.get(entry.oldId)!,
          stamp = now()
        const context = {
          ...entry.context,
          phase: entry.context.phase === 'running' ? ('interrupted' as const) : entry.context.phase,
        }
        const meta: ManagedSessionMeta = {
          id: key,
          projectId: 'default',
          kind: entry.kind,
          ...(entry.purpose ? { purpose: entry.purpose } : {}),
          title: entry.title,
          memoryDisabled: entry.memoryDisabled,
          state: options.archived ? 'archived' : 'active',
          phase: context.phase,
          createdAt: entry.createdAt,
          updatedAt: stamp,
          revision: 0,
          imported: true,
          originSessionId: entry.oldId,
          needsBinding: entry.kind === 'file',
          summaryPreview: redacted(entry.markdown).slice(0, 700),
          memoryPreview:
            redacted(entry.markdown).slice(0, 600) +
            '\n' +
            (entry.memory?.automaticEntries
              .map((item) => item.markdown)
              .join('\n')
              .slice(-600) ?? ''),
          ...(entry.parent ? { parentId: mapping.get(entry.parent)! } : {}),
        }
        const doc: ManagedSessionDocument = {
          schema: 'bigdog.session',
          version: 1,
          meta,
          context,
          transcript: entry.transcript,
          summary: { mode: 'manual', hash: hash(entry.markdown), contextRevision: 0 },
          ...(entry.memory
            ? {
                memory: {
                  ...entry.memory,
                  documentPaths: [],
                  excludedSourceIds: entry.memory.excludedSourceIds.map(
                    (id) => mapping.get(id) ?? id,
                  ),
                  automaticEntries: entry.memory.automaticEntries.map((item) => ({
                    ...item,
                    sourceSessionId: key,
                    kind: 'reported_context' as const,
                  })),
                },
              }
            : {}),
        }
        if (entry.results) {
          const outcomes = entry.results.records
            .flatMap((result) => outcomeMemoriesFromRecord(key, result))
            .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id))
            .slice(0, MAX_MEMORY_OUTCOMES)
          doc.memory = { ...normalizeMemory(doc.memory, key), outcomes }
          meta.outcomeCount = outcomes.length
          meta.outcomePreview = outcomes
            .map(
              (item) =>
                item.file.name +
                ' ' +
                item.changes
                  .map((change) => (change.before ?? '') + ' ' + (change.after ?? ''))
                  .join(' '),
            )
            .join('\n')
            .slice(0, 4000)
        }
        created.push(key)
        this.writeDocument(doc, entry.markdown)
        if (entry.results) this.writeImportedResults(key, entry.results)
        index.sessions[key] = meta
      }
      if (options.requestId) {
        index.importedCommands ??= {}
        index.importedCommands[options.requestId] = {
          digest: importDigest,
          rootId: mapping.get(String(bundle.rootId))!,
        }
      }
      this.writeIndex(index)
    } catch (error) {
      for (const key of created) rmSync(this.directory(key), { recursive: true, force: true })
      throw error
    }
    this.changed()
    return { ...index.sessions[mapping.get(String(bundle.rootId))!]! }
  }
  searchMemory(
    query: string,
    projectId?: string,
    limit = 8,
  ): Array<{
    id: string
    title: string
    projectId: string
    text: string
    kind?: string
    recordId?: string
    evidenceId?: string
  }> {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const result = []
    for (const meta of this.list({ ...(projectId ? { projectId } : {}), state: 'active' })) {
      if (meta.memoryDisabled) continue
      const part = this.readMemoryParts(meta.id).find((item) =>
        item.text.toLocaleLowerCase().includes(needle),
      )
      if (!part) continue
      const at = part.text.toLocaleLowerCase().indexOf(needle)
      const prefix = part.outcome
        ? `${part.kind}; historical status: ${part.outcome.status}; ${part.outcome.origin}; current files must be rechecked.\n`
        : ''
      result.push({
        id: meta.id,
        title: meta.title,
        projectId: meta.projectId,
        kind: part.kind,
        ...(part.outcome
          ? { recordId: part.outcome.recordId, evidenceId: part.outcome.evidenceId }
          : {}),
        text:
          prefix +
          part.text.slice(Math.max(0, at - 200), Math.max(0, at - 200) + 1500 - prefix.length),
      })
      if (result.length >= Math.max(1, Math.min(20, limit))) break
    }
    return result
  }
}

const profileStores = new Map<string, ManagedSessionStore>()
export function sessionStoreFor(userData: string): ManagedSessionStore {
  let key = resolve(userData)
  try {
    key = realpathSync(key)
  } catch {}
  if (process.platform === 'win32') key = key.toLowerCase()
  let store = profileStores.get(key)
  if (!store) {
    store = new ManagedSessionStore(userData)
    profileStores.set(key, store)
  }
  return store
}
