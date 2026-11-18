import type {
  AgentSkill,
  AgentStreamCallbacks,
  AgentToolCall,
  AgentToolDef,
  AgentTransport,
  ToolExecution,
} from '@genoffice/agent-core'

/** Stable identity exposed to an Agent adapter.  The desktop implementation
 * stores this locally, while a hosted adapter can map it to a cloud workspace. */
export interface HarnessWorkspaceBinding {
  provider: 'deepseek-harness' | (string & {})
  workspaceId: string
  root: string
}

/** Harness session identity.  `id` deliberately remains compatible with the
 * existing Shell session id so old persisted sessions can be resumed. */
export interface HarnessSessionBinding {
  provider: 'deepseek-harness' | (string & {})
  sessionId: string
  workspaceId: string
  eventLogPath?: string
}

export interface HarnessToolContext {
  sessionId?: string
  workspaceId?: string
  signal?: AbortSignal
  metadata?: Readonly<Record<string, unknown>>
}

export type HarnessToolExecutor = (
  call: AgentToolCall,
  context: HarnessToolContext,
) => ToolExecution | Promise<ToolExecution>

export type HarnessPreExecuteHook = (
  call: AgentToolCall,
  context: HarnessToolContext,
) => AgentToolCall | void | Promise<AgentToolCall | void>

export type HarnessGuardHook = (
  call: AgentToolCall,
  context: HarnessToolContext,
) => string | boolean | void | Promise<string | boolean | void>

export type HarnessPostExecuteHook = (
  call: AgentToolCall,
  execution: ToolExecution,
  context: HarnessToolContext,
) => ToolExecution | void | Promise<ToolExecution | void>

export interface HarnessToolRegistration {
  definition: AgentToolDef
  execute: HarnessToolExecutor
}

export interface HarnessLoopOptions<TSnapshot = unknown> {
  taskExecution?(): import('@genoffice/agent-core').AgentTaskExecution | undefined
  skill: AgentSkill
  transport?: AgentTransport
  events?: import('@genoffice/agent-core').AgentLoopEvents<TSnapshot>
  maxTurns?: number
  maxHistory?: number
  runTimeoutMs?: number
  runTimeoutError?(): string
  compaction?: import('@genoffice/agent-core').CompactionOptions | false
  captureSnapshot?(): TSnapshot
  formatUserMessage?(instruction: string, context: string): string
  systemSuffix?(): string
  toolContext?: HarnessToolContext
  registry?: import('./tool-registry').HarnessToolRegistry
}

/** The adapter boundary used by the Shell.  Concrete adapters may use a local
 * AgentLoop or a remote Harness SDK without leaking that choice to callers. */
export interface HarnessAgentAdapter {
  readonly id: string
  readonly registry: import('./tool-registry').HarnessToolRegistry
  createLoop<TSnapshot = unknown>(
    options: HarnessLoopOptions<TSnapshot>,
  ): import('@genoffice/agent-core').AgentLoop<TSnapshot>
  createTransport(): AgentTransport
}

/** Small transport shape useful to tests and alternate provider adapters. */
export type HarnessStreamFactory = (
  request: import('@genoffice/agent-core').AgentStreamRequest,
  callbacks: AgentStreamCallbacks,
) => import('@genoffice/agent-core').AgentStreamHandle
