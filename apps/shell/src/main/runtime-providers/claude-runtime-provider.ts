import {
  TEXT_ONLY_RUNTIME_CAPABILITIES,
  type ModelEvent,
  type ProviderStatus,
  type RuntimeProvider,
} from '../../shared/runtime-provider-api'

export const CLAUDE_THIRD_PARTY_AUTH_POLICY_URL =
  'https://code.claude.com/docs/en/agent-sdk/overview#authentication'

const BLOCKED_REASON =
  'Anthropic requires prior approval before a third-party product can offer claude.ai login or use Claude subscription rate limits.'

/**
 * The phase-one Claude boundary is intentionally policy-blocked.
 *
 * It exists so an approved official integration can be plugged into the same
 * lifecycle later, without ever extracting Claude credentials or imitating a
 * private protocol. It must not silently fall back to a token workaround.
 */
export class ClaudeRuntimeProvider implements RuntimeProvider {
  readonly id = 'claude' as const
  readonly capabilities = TEXT_ONLY_RUNTIME_CAPABILITIES

  async detect(): Promise<boolean> {
    return false
  }

  async install(): Promise<void> {
    throw new Error(BLOCKED_REASON)
  }

  async login(): Promise<void> {
    throw new Error(BLOCKED_REASON)
  }

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      label: 'Claude',
      phase: 'blocked',
      installed: false,
      authenticated: false,
      ready: false,
      capabilities: this.capabilities,
      blockedReason: BLOCKED_REASON,
      policyUrl: CLAUDE_THIRD_PARTY_AUTH_POLICY_URL,
    }
  }

  async *generate(_prompt: string): AsyncIterable<ModelEvent> {
    yield { type: 'error', error: BLOCKED_REASON }
  }

  async cancel(): Promise<void> {}
}
