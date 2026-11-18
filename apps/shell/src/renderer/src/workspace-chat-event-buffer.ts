import type { WorkspaceAgentEvent } from '../../shared/workspace-agent-api'

/** Coalesce token IPC bursts; discrete events flush synchronously in arrival
 * order so approvals, errors and terminal statuses never overtake text. */
export function createChatEventBuffer(consume: (events: WorkspaceAgentEvent[]) => void) {
  let pending: WorkspaceAgentEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!pending.length || disposed) return
    const batch = pending
    pending = []
    consume(batch)
  }
  return {
    push(event: WorkspaceAgentEvent) {
      if (disposed) return
      pending.push(event)
      const delta =
        event.type === 'assistant.reasoning_summary' ||
        (event.type === 'assistant.message' && event.role !== 'user')
      if (!delta) flush()
      else if (timer === undefined) timer = setTimeout(flush, 32)
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = []
    },
  }
}
