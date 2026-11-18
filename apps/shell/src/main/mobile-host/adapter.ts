import { createHash } from 'node:crypto'
import type { ManagedSessionStore, PortableResults, SessionService } from '@genoffice/project-store'
import { recoverConversation } from '@genoffice/project-store/browser'
import type { WorkspaceAgentRuntime } from '../workspace-agent/service'
import type { AssistantTaskService } from '../agent-tasks/service'
import { taskHash } from '../agent-tasks/assistant-store'
import type { MobileHostDependencies } from './server'
import { submitAssistantMessage } from './submit'

export function createMobileHostDependencies(options: {
  store: ManagedSessionStore
  sessions: SessionService
  runtime(): WorkspaceAgentRuntime
  tasks(): AssistantTaskService
  preview?(name: string, bytes: Buffer): Promise<Buffer>
  authorizeWrite?(sessionId: string): Promise<void>
  transfer?: MobileHostDependencies['transfer']
}): MobileHostDependencies {
  const { store } = options
  return {
    sessions: options.sessions,
    preview: options.preview,
    prepareImport: async (id) => {
      for (const meta of store.scope(id))
        if (meta.kind !== 'file' && meta.state === 'active')
          await options.runtime().prepareManagedSession(meta.id)
    },
    prepareExport: async (id) => {
      const meta = store.info(id)
      if (meta.source?.type === 'workspace')
        await options.runtime().flushDisplayForTransfer(meta.source.sessionId ?? id)
    },
    authorizeWrite: options.authorizeWrite,
    transfer: options.transfer,
    session: (id) => store.info(id),
    history: async (id) => {
      const meta = store.info(id)
      if (meta.source?.type === 'workspace')
        return options.runtime().getSessionDisplaySnapshot(meta.source.sessionId ?? id)
      const saved = store.get(id).session
      return {
        messages: saved.transcript.length
          ? saved.transcript
          : recoverConversation(saved.context).messages,
        cursor: 0,
      }
    },
    events: async (id) => {
      const meta = store.info(id)
      return meta.source?.type === 'workspace'
        ? options.runtime().getSessionEvents(meta.source.sessionId ?? id, 0, true)
        : []
    },
    send: async (actor, id, requestId, text) => {
      const runtime = options.runtime()
      await runtime.prepareManagedSession(id)
      return submitAssistantMessage(
        options.tasks(),
        runtime,
        id,
        {
          text,
          requestId: taskHash(['mobile-dev', actor.principalId, actor.deviceId, id, requestId]),
        },
        false,
      )
    },
    receipt: (actor, id, requestId) => {
      const receipt = options
        .tasks()
        .store.receiptForRequest(
          taskHash(['mobile-dev', actor.principalId, actor.deviceId, id, requestId]),
        )
      if (!receipt || receipt.task.sessionId !== id) return null
      return { taskId: receipt.task.id, text: receipt.request.input.text.trim() }
    },
    control: async (_id, input) => options.tasks().control(input),
    permissions: (id, taskId) =>
      options.runtime().taskPermissions(store.info(id).source?.sessionId ?? id, taskId),
    approve: (id, taskId, confirmationId, revision, permissionId, allowed) => {
      const task = options.tasks().store.get(taskId)
      if (
        task.sessionId !== id ||
        task.state !== 'waiting_user' ||
        task.revision !== revision ||
        task.confirmation?.id !== confirmationId ||
        task.confirmation.kind !== 'approval'
      )
        throw new Error('STALE_TASK_APPROVAL')
      options
        .runtime()
        .resolveTaskPermission(
          store.info(id).source?.sessionId ?? id,
          taskId,
          permissionId,
          allowed,
        )
    },
    answer: async (_id, input) => {
      const kind = options.tasks().store.get(input.taskId).confirmation?.kind
      const receipt = options.tasks().answer(input, false)
      if (!receipt.duplicate && kind === 'clarification')
        await options.runtime().recordTaskReply(_id, input.answer)
      options.tasks().start()
      return receipt.task
    },
    // Do not call feed(): its notice delivery/acknowledgement belongs to the desktop consumer.
    tasks: (id) => options.tasks().store.forSession(id),
    results: async (id) => {
      const records = store.resultRecords(id)
      const artifacts: PortableResults['artifacts'] = []
      const ids = new Set(
        records.flatMap((record) =>
          record.files.flatMap((file) => (file.artifactId ? [file.artifactId] : [])),
        ),
      )
      for (const artifactId of ids) {
        try {
          const { name, bytes } = store.resultArtifact(id, artifactId)
          artifacts.push({
            id: artifactId,
            name,
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            base64: bytes.toString('base64'),
          })
        } catch {
          /* Invalid/missing snapshots remain evidence without a downloadable artifact. */
        }
      }
      return options.runtime().exportTaskResults(store.info(id), { version: 1, records, artifacts })
    },
  }
}
