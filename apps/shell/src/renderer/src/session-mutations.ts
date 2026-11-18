import type {
  ManagedSessionsApi,
  SessionCommand,
  SessionVersion,
  SessionView,
} from '@genoffice/project-store'

type Existing = Exclude<SessionCommand, { kind: 'create' }>
type Change<T> = T extends Existing ? Omit<T, 'requestId' | 'sessionId' | 'expected'> : never
export type SessionChange = Change<Existing>

/** Retain the same command ID after an uncertain IPC response; changing the draft makes a new command. */
export class SessionMutationDraft {
  private pending?: { body: string; command: SessionCommand }
  async apply(
    api: ManagedSessionsApi,
    view: SessionView,
    change: SessionChange,
  ): Promise<SessionVersion | undefined> {
    const id = view.session.meta.id
    if (api.command && view.version) {
      const data = { ...change, sessionId: id, expected: view.version }
      const body = JSON.stringify(data)
      if (this.pending?.body !== body)
        this.pending = {
          body,
          command: { ...data, requestId: crypto.randomUUID() } as SessionCommand,
        }
      const pending = this.pending
      const receipt = await api.command(pending.command)
      if (this.pending === pending) this.pending = undefined
      return receipt.version
    }
    // Older local shells keep their existing IPC contract. Remote always requires v1 commands.
    switch (change.kind) {
      case 'rename':
        await api.rename(id, change.title)
        break
      case 'update_memory':
        await api.updateSummary(id, change.markdown)
        break
      case 'set_memory_enabled':
        await api.setMemoryEnabled(id, change.enabled)
        break
      case 'move':
        await api.move(id, change.projectId, change.parentId)
        break
      case 'archive':
        await api.archive(id, change.archived)
        break
      case 'trash':
        await api.trash(id)
        break
      case 'restore':
        await api.restore(id)
        break
    }
    return undefined
  }
}
export function sessionMutationError(error: unknown, zh: boolean): string {
  const text = String(error)
  if (text.includes('SESSION_CONFLICT'))
    return zh
      ? '会话或记忆已在其他位置更新，本次未覆盖。当前编辑仍保留，请核对最新内容后合并。'
      : 'This conversation or memory changed elsewhere. Your draft is retained and nothing was overwritten. Review the latest content before merging.'
  if (text.includes('SESSION_BUSY'))
    return zh
      ? '请先停止正在运行的会话，再修改分类或移入回收站。'
      : 'Stop the running conversation before changing its location or lifecycle.'
  return text
}
