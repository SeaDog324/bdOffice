import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'

/** Provider-neutral function name constraints. Keep semantic names internally,
 * but map them at the wire boundary because several APIs reject dots and other
 * punctuation even though the Agent tool contract permits it. */
export const PROVIDER_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/
export const PROVIDER_TOOL_NAME_MAX_LENGTH = 64

export interface ProviderToolNameMap {
  toWire(name: string): string
  fromWire(name: string): string
}

export function providerToolNames(
  messages: readonly AgentMessage[],
  tools: readonly AgentToolDef[],
): ProviderToolNameMap {
  const names = [
    ...tools.map((tool) => tool.name),
    ...messages.flatMap((message) => {
      if (message.role === 'assistant') return (message.toolCalls ?? []).map((call) => call.name)
      if (message.role === 'tool') return message.results.map((result) => result.name)
      return []
    }),
  ]
  const canonicalToWire = new Map<string, string>()
  const wireToCanonical = new Map<string, string>()
  const used = new Set(
    names.filter(
      (name) =>
        name.length <= PROVIDER_TOOL_NAME_MAX_LENGTH && PROVIDER_TOOL_NAME_PATTERN.test(name),
    ),
  )

  for (const name of names) {
    if (canonicalToWire.has(name)) continue
    if (
      name.length <= PROVIDER_TOOL_NAME_MAX_LENGTH &&
      PROVIDER_TOOL_NAME_PATTERN.test(name)
    ) {
      canonicalToWire.set(name, name)
      wireToCanonical.set(name, name)
      continue
    }
    const base =
      name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, PROVIDER_TOOL_NAME_MAX_LENGTH) ||
      'tool'
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) {
      const tail = `_${suffix++}`
      candidate = `${base.slice(0, PROVIDER_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`
    }
    used.add(candidate)
    canonicalToWire.set(name, candidate)
    wireToCanonical.set(candidate, name)
  }

  return {
    toWire: (name) => canonicalToWire.get(name) ?? name,
    fromWire: (name) => wireToCanonical.get(name) ?? name,
  }
}
