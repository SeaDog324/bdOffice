import type { AgentSessionBudget, AgentSessionSnapshot } from '@genoffice/agent-core'
import type { ChatMessage } from './types'
import type {
  SessionCommand,
  SessionCommandReceipt,
  SessionMutationOptions,
  SessionVersion,
} from './session-command-types.js'
export type ManagedSessionKind = 'workspace' | 'file' | 'home'
export type ManagedSessionState = 'active' | 'archived' | 'trashed'
export interface ManagedProject {
  id: string
  name: string
  folder?: string
  createdAt: string
  updatedAt: string
}
export interface SessionSource {
  type: 'workspace' | 'chat'
  workspaceId?: string
  sessionId?: string
  projectId?: string
  chatId?: string
  filePath?: string
}
export interface ManagedSessionMeta {
  purpose?: 'maintenance'
  id: string
  projectId: string
  parentId?: string
  kind: ManagedSessionKind
  title: string
  state: ManagedSessionState
  phase: AgentSessionSnapshot['phase']
  createdAt: string
  updatedAt: string
  deletedAt?: string
  source?: SessionSource
  imported?: boolean
  originSessionId?: string
  needsBinding?: boolean
  manualTitle?: boolean
  summaryPreview: string
  revision: number
  documentPaths?: string[]
  memoryPreview?: string
  summaryDigest?: string
  memoryDisabled?: boolean
  outcomePreview?: string
  outcomeCount?: number
}
export interface SessionMemoryState {
  version: 1
  /** Derived from host result records; never written by summary/model tools. */
  outcomes?: import('./outcome-memory.js').OutcomeMemoryEntry[]
  automaticEntries: Array<{
    id: string
    sourceSessionId: string
    kind: 'reported_context'
    markdown: string
    revision: number
  }>
  documentPaths: string[]
  excludedSourceIds: string[]
  legacySummaryDigest: string
}
export interface ManagedSessionDocument {
  schema: 'bigdog.session'
  version: 1
  meta: ManagedSessionMeta
  context: AgentSessionSnapshot
  transcript: ChatMessage[]
  selection?: SessionContextSelection
  summary: { mode: 'auto' | 'manual'; hash: string; contextRevision: number }
  memory?: SessionMemoryState
}
export interface SessionContextSelection {
  workspaceMemory: boolean
  sessionIds: string[]
  projectIds: string[]
  filePaths: string[]
  excludedSessionIds?: string[]
}
export interface SessionBundle {
  schema: 'bigdog.session-bundle'
  version: 1 | 2 | 3
  rootId: string
  sessions: Array<{
    session: ManagedSessionDocument
    markdown: string
    results?: import('./result-evidence.js').PortableResults
  }>
}
export interface SessionListFilter {
  projectId?: string
  state?: ManagedSessionState | 'all'
  kind?: ManagedSessionKind
  query?: string
}
export interface SessionView {
  session: ManagedSessionDocument
  markdown: string
  /** Present on current hosts; optional only for older local IPC implementations. */
  version?: SessionVersion
}
export interface ManagedSessionsApi {
  projects(): Promise<ManagedProject[]>
  createProject(name: string): Promise<ManagedProject>
  renameProject(id: string, name: string): Promise<ManagedProject>
  bindProjectFolder(id: string): Promise<ManagedProject | null>
  list(filter?: SessionListFilter): Promise<ManagedSessionMeta[]>
  get(id: string): Promise<SessionView>
  create(projectId?: string, parentId?: string): Promise<ManagedSessionMeta>
  rename(id: string, title: string, options?: SessionMutationOptions): Promise<ManagedSessionMeta>
  move(
    id: string,
    projectId: string,
    parentId?: string | null,
    options?: SessionMutationOptions,
  ): Promise<void>
  archive(id: string, archived: boolean): Promise<void>
  trash(id: string): Promise<void>
  restore(id: string): Promise<void>
  /** Available only through a user-confirmed UI action; never exposed as an Agent tool. */
  destroy(id: string): Promise<boolean>
  updateSummary(id: string, markdown: string, options?: SessionMutationOptions): Promise<void>
  setMemoryEnabled(id: string, enabled: boolean, options?: SessionMutationOptions): Promise<void>
  command?(command: SessionCommand): Promise<SessionCommandReceipt>
  resume(id: string): Promise<{ kind: ManagedSessionKind; sessionId?: string; cancelled?: boolean }>
  cancel(id: string): Promise<void>
  exportSession(id: string): Promise<string | null>
  importSession(): Promise<ManagedSessionMeta | null>
  onChanged(listener: () => void): () => void
}
export type { AgentSessionBudget, AgentSessionSnapshot }
