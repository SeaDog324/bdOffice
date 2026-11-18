import { randomUUID } from 'node:crypto'
import type { AgentSessionSnapshot } from '@genoffice/agent-core'
import type { ProjectStore } from './store.js'
import type { ResolveChatResult } from './ipc.js'

type Store = Pick<ProjectStore, 'loadChat'> &
  Partial<
    Pick<
      ProjectStore,
      'managedChat' | 'loadConversationContext' | 'saveConversationContext' | 'startConversation'
    >
  >
export interface ChatContextSender {
  id: number
  send?(channel: string, value: unknown): void
  once?(event: string, listener: () => void): unknown
  isDestroyed?(): boolean
}
interface Event {
  sender: ChatContextSender
  senderFrame?: unknown
}
interface Ipc {
  handle(channel: string, callback: (event: Event, ...args: any[]) => unknown): void
}
interface Bound {
  ids: ResolveChatResult
  filePath?: string
  sender: ChatContextSender
  writerId?: string
}
export interface ChatContextController {
  bind(event: Event, ids: ResolveChatResult, filePath?: string): ResolveChatResult
  current(senderId: number): Bound | undefined
  activate(sender: ChatContextSender, ids: ResolveChatResult, filePath?: string): void
  cancel(source: { projectId?: string; chatId?: string }): boolean
}
/** Opaque leases prevent an old panel from checkpointing into a newly selected conversation. */
export function registerChatContextIpc(options: {
  ipcMain: Ipc
  getStore: () => Store
  senderFile?: (senderId: number) => string | undefined
}): ChatContextController {
  const bound = new Map<number, Map<string, Bound>>()
  const keyOf = (ids: ResolveChatResult) => `${ids.projectId}/${ids.chatId}`
  const active = new Map<number, string>()
  const pending = new Map<number, ResolveChatResult>()
  const controller: ChatContextController = {
    bind(event, ids, filePath) {
      if (!options.getStore().loadConversationContext) return ids
      let entries = bound.get(event.sender.id)
      if (!entries) {
        entries = new Map()
        bound.set(event.sender.id, entries)
        event.sender.once?.('destroyed', () => {
          for (const entry of bound.get(event.sender.id)?.values() ?? []) {
            try {
              const store = options.getStore(),
                snapshot = store.loadConversationContext?.(
                  entry.ids.projectId,
                  entry.ids.chatId,
                  entry.filePath,
                )
              if (snapshot?.phase === 'running')
                store.saveConversationContext?.(
                  entry.ids.projectId,
                  entry.ids.chatId,
                  { ...snapshot, phase: 'interrupted' },
                  entry.filePath,
                )
            } catch {
              /* Inactive sessions retain their existing checkpoint. */
            }
          }
          bound.delete(event.sender.id)
          active.delete(event.sender.id)
          pending.delete(event.sender.id)
        })
      }
      const key = keyOf(ids),
        previous = entries.get(key)
      const next = { ...ids, contextToken: previous?.ids.contextToken ?? randomUUID() }
      entries.set(key, {
        ...previous,
        ids: next,
        sender: event.sender,
        ...(filePath ? { filePath } : {}),
      })
      active.set(event.sender.id, key)
      return next
    },
    current: (id) => bound.get(id)?.get(active.get(id) ?? ''),
    activate(sender, ids, filePath) {
      const next = controller.bind({ sender }, ids, filePath)
      const entry = bound.get(sender.id)?.get(keyOf(next))
      if (entry) delete entry.writerId
      pending.set(sender.id, next)
      sender.send?.('project:chat-activated', next)
    },
    cancel(source) {
      let sent = false
      for (const entries of bound.values())
        for (const entry of entries.values()) {
          if (
            entry.ids.projectId === source.projectId &&
            entry.ids.chatId === source.chatId &&
            !entry.sender.isDestroyed?.()
          ) {
            entry.sender.send?.('project:cancel-chat', source)
            sent = true
          }
        }
      return sent
    },
  }
  const owned = (event: Event, value: unknown): Bound => {
    const args = value && typeof value === 'object' ? (value as ResolveChatResult) : null
    const current = args ? bound.get(event.sender.id)?.get(keyOf(args)) : undefined
    if (
      !current ||
      !args ||
      event.sender.isDestroyed?.() ||
      args.projectId !== current.ids.projectId ||
      args.chatId !== current.ids.chatId ||
      args.contextToken !== current.ids.contextToken
    )
      throw new Error('This conversation binding has changed; reload its context before saving.')
    const file = options.senderFile?.(event.sender.id)
    if (file) current.filePath = file
    return current
  }
  options.ipcMain.handle('project:pendingChat', (event, consume) => {
    const value = pending.get(event.sender.id) ?? null
    if (consume === true) pending.delete(event.sender.id)
    return value
  })
  options.ipcMain.handle('project:loadContext', (event, value) => {
    const current = owned(event, value)
    const writerId = (value as { writerId?: unknown }).writerId
    if (writerId !== undefined) {
      if (typeof writerId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(writerId))
        throw new Error('Invalid conversation writer.')
      current.writerId = writerId
    }
    return (
      options
        .getStore()
        .loadConversationContext?.(current.ids.projectId, current.ids.chatId, current.filePath) ??
      null
    )
  })
  options.ipcMain.handle('project:saveContext', (event, value) => {
    const current = owned(event, value)
    if ((value as { writerId?: unknown }).writerId !== current.writerId || !current.writerId)
      throw new Error('A newer conversation view owns this checkpoint.')
    const snapshot = (value as { snapshot?: unknown }).snapshot as AgentSessionSnapshot
    if (!snapshot || snapshot.version !== 1) throw new Error('Invalid conversation checkpoint.')
    options
      .getStore()
      .saveConversationContext?.(
        current.ids.projectId,
        current.ids.chatId,
        snapshot,
        current.filePath,
      )
  })
  options.ipcMain.handle('project:newConversation', (event, value) => {
    const current = owned(event, value)
    const store = options.getStore()
    if (!store.startConversation) return current.ids
    const ids = store.startConversation(current.ids.projectId, current.ids.chatId, current.filePath)
    return controller.bind(event, ids, current.filePath)
  })
  return controller
}
