import type { AiProviderId } from '@genoffice/ai-provider'
import type { AgentRuntimeSelection } from './runtime-provider-api'

export type OnboardingChoice = 'connected' | 'existing' | 'skipped'
export interface ConnectionSummary {
  revision: string
  selection: AgentRuntimeSelection
  providerId: AiProviderId
  modelId: string
  usable: boolean
  status: 'unconfigured' | 'configured' | 'ready' | 'unavailable'
}
export type ConnectionSetupError =
  | 'invalid_input'
  | 'settings_changed'
  | 'account_selected'
  | 'test_failed'
  | 'test_cancelled'
  | 'verification_expired'
  | 'save_failed'
export interface ConnectionDraft {
  requestId: string
  expectedRevision: string
  providerId: AiProviderId
  apiKey: string
  modelId?: string
  baseUrl?: string
}
export type ConnectionTestResult =
  | { ok: true; verificationId: string; expiresAt: number }
  | { ok: false; errorCode: ConnectionSetupError }
export type ConnectionCommitResult =
  { ok: true; connection: ConnectionSummary } | { ok: false; errorCode: ConnectionSetupError }
export interface ConnectionSetupApi {
  inspect(): Promise<ConnectionSummary>
  test(draft: ConnectionDraft): Promise<ConnectionTestResult>
  commit(input: {
    verificationId: string
    expectedRevision: string
  }): Promise<ConnectionCommitResult>
  cancel(requestId: string): Promise<void>
  openHelp(page: 'deepseek-platform' | 'deepseek-docs'): Promise<void>
}
export const CONNECTION_SETUP_CHANNELS = {
  inspect: 'connection-setup:inspect',
  test: 'connection-setup:test',
  commit: 'connection-setup:commit',
  cancel: 'connection-setup:cancel',
  openHelp: 'connection-setup:open-help',
} as const
