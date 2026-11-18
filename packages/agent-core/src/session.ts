import type { AgentMessage } from './types'
import type { AgentTaskExecution } from './task-execution'

export interface AgentSessionBudget {
  maxTurns: number
  maxHistory: number
  runTimeoutMs: number
  compaction: false | { maxBytes: number; keepRecentBytes: number; disableLlmSummary?: boolean }
}
export type AgentSessionPhase = 'idle' | 'running' | 'cancelled' | 'error' | 'interrupted'
export interface AgentSessionSnapshot {
  version: 1
  messages: AgentMessage[]
  budget: AgentSessionBudget
  phase: AgentSessionPhase
  updatedAt: string
  pendingInput?: string
}
/** A host-owned conversation store; it never executes restored tools. */
export interface AgentSessionPersistence {
  /** Optional Shell task ownership for an editor conversation. */
  taskExecution?(): AgentTaskExecution | undefined
  newConversation?(): Promise<void>
  available?(): boolean
  prepare(signal: AbortSignal): Promise<AgentSessionSnapshot | null>
  save(snapshot: AgentSessionSnapshot): void | Promise<void>
}
export const sessionBudget = (workspace = false): AgentSessionBudget => ({
  maxTurns: workspace ? 32 : 100,
  maxHistory: workspace ? 80 : 40,
  runTimeoutMs: 600_000,
  compaction: { maxBytes: 256 * 1024, keepRecentBytes: 96 * 1024 },
})
