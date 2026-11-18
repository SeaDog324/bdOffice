import type { AgentTokenUsage } from '@genoffice/agent-core'

type Protocol = 'openai' | 'openai-responses' | 'anthropic' | 'gemini'
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
function sum(...values: unknown[]): number | undefined {
  const known = values.map(count).filter((n): n is number => n !== undefined)
  const total = known.reduce((a, b) => a + b, 0)
  return known.length && Number.isSafeInteger(total) ? total : undefined
}

/** Read response metadata only; request/auth/endpoint behavior is unchanged.
 * Provider frames contain cumulative counters, so emit once per turn, not once per frame.
 * Missing/invalid counters stay unknown instead of becoming a fabricated zero. */
export function createUsageReporter(protocol: Protocol, emit?: (usage: AgentTokenUsage) => void) {
  const usage: AgentTokenUsage = {}
  let finished = false
  return {
    observe(value: unknown): void {
      const event = record(value)
      const raw = record(
        protocol === 'gemini'
          ? event.usageMetadata
          : (event.usage ?? record(event.response).usage ?? record(event.message).usage),
      )
      const input =
        protocol === 'gemini'
          ? count(raw.promptTokenCount)
          : protocol === 'anthropic'
            ? sum(raw.input_tokens, raw.cache_creation_input_tokens, raw.cache_read_input_tokens)
            : count(protocol === 'openai-responses' ? raw.input_tokens : raw.prompt_tokens)
      const output =
        protocol === 'gemini'
          ? sum(raw.candidatesTokenCount, raw.thoughtsTokenCount)
          : count(
              protocol === 'anthropic' || protocol === 'openai-responses'
                ? raw.output_tokens
                : raw.completion_tokens,
            )
      if (input !== undefined) usage.inputTokens = input
      if (output !== undefined) usage.outputTokens = output
    },
    finish(): void {
      if (finished) return
      finished = true
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) emit?.({ ...usage })
    },
  }
}
