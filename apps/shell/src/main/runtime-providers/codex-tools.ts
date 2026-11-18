import type { AgentToolDef } from '@genoffice/agent-core'

/** Runtime 0.153.4 generated DynamicToolSpec: tagged `function`, inputSchema.
 * Workspace names contain dots; expose legal, collision-free wire aliases and
 * map them back before validation/approval. Never guess a requested alias. */
export function codexDynamicTools(tools: readonly AgentToolDef[]) {
  const names = new Set<string>()
  const aliases = new Map<string, string>()
  const definitions = tools.map((tool, index) => {
    if (names.has(tool.name)) throw new Error(`Duplicate Office tool: ${tool.name}`)
    names.add(tool.name)
    const name = `bigdog_${index}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 42)}`
    aliases.set(name, tool.name)
    return {
      type: 'function' as const,
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }
  })
  return { aliases, definitions }
}
