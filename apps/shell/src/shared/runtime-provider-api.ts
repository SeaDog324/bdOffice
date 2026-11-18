/** Local, vendor-owned agent runtimes that can use an existing subscription. */
import type { AgentToolCall, AgentToolDef, ToolExecution } from '@genoffice/agent-core'
export type RuntimeProviderId = 'claude' | 'codex'

/** `api` keeps the existing direct API-key provider path. */
export type AgentRuntimeSelection = 'api' | RuntimeProviderId

export type RuntimeProviderPhase =
  | 'not-installed'
  | 'installing'
  | 'preparing'
  | 'signed-out'
  | 'authenticating'
  | 'ready'
  | 'error'
  | 'blocked'

export interface RuntimeProviderCapabilities {
  streamingText: boolean
  imageInput: boolean
  /** Structured Office tool calls routed back through the Harness registry. */
  officeTools: boolean
}

export const TEXT_ONLY_RUNTIME_CAPABILITIES: Readonly<RuntimeProviderCapabilities> = {
  streamingText: true,
  imageInput: false,
  officeTools: false,
}

export const OFFICE_RUNTIME_CAPABILITIES: Readonly<RuntimeProviderCapabilities> = {
  streamingText: true,
  imageInput: false,
  officeTools: true,
}

export interface RuntimeGenerateOptions {
  tools: AgentToolDef[]
  /** Executed by AgentLoop through the normal registry/approval/review path. */
  executeTool(call: AgentToolCall): Promise<ToolExecution>
}

export interface ProviderStatus {
  id: RuntimeProviderId
  label: string
  phase: RuntimeProviderPhase
  installed: boolean
  authenticated: boolean
  ready: boolean
  capabilities: RuntimeProviderCapabilities
  version?: string
  accountLabel?: string
  plan?: string
  error?: string
  /** Human-readable vendor-policy boundary. Never contains credentials. */
  blockedReason?: string
  policyUrl?: string
}

export type ModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'status'; status: 'starting' | 'streaming' | 'cancelling' }
  | { type: 'done'; stopReason?: string }
  | { type: 'error'; error: string }

/**
 * Common boundary for vendor-owned local runtimes.
 *
 * OAuth credentials deliberately do not appear anywhere in this interface:
 * the official runtime owns token storage, refresh, subscription checks, and
 * upstream protocols.
 */
export interface RuntimeProvider {
  readonly id: RuntimeProviderId
  readonly capabilities: RuntimeProviderCapabilities
  detect(): Promise<boolean>
  install(): Promise<void>
  login(): Promise<void>
  status(): Promise<ProviderStatus>
  generate(prompt: string, options?: RuntimeGenerateOptions): AsyncIterable<ModelEvent>
  cancel(): Promise<void>
  /** Separate official connection for nested editor requests; credentials stay vendor-owned. */
  fork?(): RuntimeProvider
  dispose?(): Promise<void>
}

export interface RuntimeProvidersSnapshot {
  selection: AgentRuntimeSelection
  providers: ProviderStatus[]
}

export const RUNTIME_PROVIDER_CHANNELS = {
  snapshot: 'runtime-provider:snapshot',
  connect: 'runtime-provider:connect',
  install: 'runtime-provider:install',
  login: 'runtime-provider:login',
  select: 'runtime-provider:select',
  logout: 'runtime-provider:logout',
} as const

export function isRuntimeProviderId(value: unknown): value is RuntimeProviderId {
  return value === 'claude' || value === 'codex'
}

export function isAgentRuntimeSelection(value: unknown): value is AgentRuntimeSelection {
  return value === 'api' || isRuntimeProviderId(value)
}
