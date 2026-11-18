import { isAbsolute } from 'node:path'
import { outcomeMemoriesFromRecord, type OutcomeMemoryEntry } from '@genoffice/project-store'
import type { AgentRunReview } from '../../shared/workspace-agent-api'
import { portableResult } from './portable-results'

export function reviewOutcomeMemory(
  sessionId: string,
  review: AgentRunReview,
): OutcomeMemoryEntry[] {
  if (review.historical) return []
  const record = portableResult(review)
  record.occurredAt = review.undoneAt ?? review.completedAt
  return outcomeMemoriesFromRecord(
    sessionId,
    record,
    new Map(
      review.changes.flatMap((change) => {
        if (!change.evidence) return []
        const path = change.documentPath ?? change.path
        return [
          [
            change.evidence.id,
            {
              effect: change.evidence.effect,
              undoState: change.undoState,
              ...(isAbsolute(path) ? { path } : {}),
              ...(change.documentId ? { documentId: change.documentId } : {}),
            },
          ],
        ]
      }),
    ),
    review.taskId,
  )
}
