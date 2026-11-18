import type { WorkspaceAgentEvent } from '../../shared/workspace-agent-api'
import { dogVisualForEvent, type DogEvent } from './dog-assets'

export interface MemePolicyState {
  requestId: string | null
  runId?: string
  eligible: boolean
  used: boolean
  closed: boolean
  milestone: DogEvent | null
  lastAt: number | null
  lastFrame: string | null
}

/** Sample once per user request, not once per tool call. Durable ids make
 * restoration and React reducer replays produce exactly the same stickers. */
function eligibleRequest(key: string): boolean {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
  return (hash >>> 0) % 100 < 35
}

export function advanceMemePolicy(
  previous: MemePolicyState | undefined,
  event: WorkspaceAgentEvent,
): { policy: MemePolicyState; reaction: DogEvent | null } {
  let policy = previous ?? {
    requestId: null,
    eligible: false,
    used: false,
    closed: false,
    milestone: null,
    lastAt: null,
    lastFrame: null,
  }
  if (event.type === 'assistant.message' && event.role === 'user' && event.text) {
    if (policy.requestId !== event.id) {
      policy = {
        ...policy,
        requestId: event.id,
        runId: event.runId,
        eligible: eligibleRequest(`${event.sessionId}:${event.id}`),
        used: false,
        closed: false,
        milestone: null,
      }
    }
    return { policy, reaction: null }
  }
  if (
    !policy.requestId ||
    policy.closed ||
    (policy.runId && event.runId && policy.runId !== event.runId)
  )
    return { policy, reaction: null }

  // Remember useful outcomes, but do not celebrate a tool start or interrupt
  // the final streaming answer with a success sticker.
  if (event.type === 'document.created') policy = { ...policy, milestone: 'ready' }
  if (event.type === 'file.modified' && !policy.milestone) policy = { ...policy, milestone: 'done' }
  if (event.type === 'tool.completed' && event.tool && !event.tool.error) {
    const name = event.tool.name
    if (/(?:^|[._])(?:save|export|persist|commit)$/.test(name) && policy.milestone !== 'ready')
      policy = { ...policy, milestone: 'save' }
    else if (event.tool.mutated && !policy.milestone) policy = { ...policy, milestone: 'done' }
  }
  let reaction: DogEvent | null = null
  if (event.type === 'permission.requested' && event.permission?.state === 'pending')
    reaction = 'approval'
  if (event.type === 'error') reaction = 'error'
  if (event.type === 'agent.status' && event.status === 'error') reaction = 'error'
  if (event.type === 'agent.status' && event.status === 'completed') reaction = policy.milestone
  if (event.type === 'error' || (event.type === 'agent.status' && event.status !== 'running'))
    policy = { ...policy, closed: true }

  const at = Date.parse(event.timestamp)
  if (!reaction || !policy.eligible || policy.used || !Number.isFinite(at))
    return { policy, reaction: null }
  const frame = dogVisualForEvent(reaction).frame
  if (
    policy.lastAt !== null &&
    (at - policy.lastAt < 45_000 || (frame === policy.lastFrame && at - policy.lastAt < 90_000))
  )
    return { policy, reaction: null }
  return { policy: { ...policy, used: true, lastAt: at, lastFrame: frame }, reaction }
}
