import { createHash } from 'node:crypto'
import type { AgentToolCall, AgentToolDef, ToolExecution } from '@genoffice/agent-core'
import type { EnvironmentService } from './service'
export const ENVIRONMENT_TOOL_ACCESS = new Map<string, 'read' | 'write'>([
  ['environment.check', 'read'],
  ['environment.plan_repair', 'read'],
  ['environment.repair', 'write'],
])
const string = { type: 'string', minLength: 1, maxLength: 128 }
export const ENVIRONMENT_TOOL_DEFS: AgentToolDef[] = [
  {
    name: 'environment.check',
    description:
      'Check the local Office environment without a paid model probe. Returns capability results and supported repairs; no shell commands or arbitrary file paths.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'environment.plan_repair',
    description:
      'Prepare a concrete repair plan from a recent environment.check report. Fixes are limited to app-owned storage, command discovery and derived search cache.',
    inputSchema: {
      type: 'object',
      properties: { reportId: string },
      required: ['reportId'],
      additionalProperties: false,
    },
  },
  {
    name: 'environment.repair',
    description:
      'Execute a prepared local repair plan and wait for actual post-checks. A completed task proves only its listed repairs; report remaining issues honestly. Never substitute arbitrary shell commands.',
    inputSchema: {
      type: 'object',
      properties: { planId: string, digest: string },
      required: ['planId', 'digest'],
      additionalProperties: false,
    },
  },
]
export async function executeEnvironmentTool(
  service: EnvironmentService,
  call: AgentToolCall,
  runId: string,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  if (signal?.aborted) throw new Error('wait_cancelled')
  if (call.name === 'environment.check')
    return {
      output: JSON.stringify(await service.check('agent')),
      summary: 'Runtime environment checked',
    }
  if (call.name === 'environment.plan_repair')
    return {
      output: JSON.stringify(service.plan(String(call.input.reportId))),
      summary: 'Repair plan prepared',
    }
  if (call.name !== 'environment.repair') throw new Error('unknown_environment_tool')
  const requestId = createHash('sha256')
    .update(runId + ':' + call.id)
    .digest('hex')
  const accepted = service.repair(
    { requestId, planId: String(call.input.planId), digest: String(call.input.digest) },
    'agent',
  )
  const task = await service.wait(accepted.id, signal)
  const completed = task.state === 'completed'
  return {
    output: JSON.stringify(task),
    summary: completed ? 'Environment repair verified' : 'Environment repair needs attention',
    mutated: task.steps.some((step) => step.effectState === 'applied'),
    isError: !completed,
  }
}
