import { registerChatContextIpc } from './chat-context-ipc.js'
import type { ProjectStore } from './store.js'
import type { AppendChatArgs, LoadChatArgs, RebindChatArgs, ResolveChatArgs } from './ipc.js'

export interface ProjectIpcEventLike {
  sender: { id: number }
}

export type ProjectIpcHandler = (event: ProjectIpcEventLike, ...args: unknown[]) => unknown

export interface ProjectIpcMainLike {
  handle(channel: string, listener: ProjectIpcHandler): void
}

type ProjectChatStore = Pick<
  ProjectStore,
  | 'ensureDefaultProject'
  | 'resolveChatForFile'
  | 'appendChatMessage'
  | 'loadChat'
  | 'rebindChatToFile'
  | 'rebindChat'
> &
  Partial<
    Pick<
      ProjectStore,
      | 'managedChat'
      | 'managedSessions'
      | 'resolveManagedConversation'
      | 'syncManagedTranscript'
      | 'conversationTranscript'
      | 'rebindManagedConversation'
    >
  >

export interface StandaloneProjectChatIpcOptions {
  ipcMain: ProjectIpcMainLike
  getStore(): ProjectChatStore
  resolveSessionPath?(senderId: number, sessionId: string): string | null
  now?(): number
}

const registered = new WeakSet<object>()

/**
 * Register the four project:* chat-history channels used by standalone editor
 * preloads. The shell owns its wider project registry; standalone editors call
 * this helper only in their own process. Repeated startup is idempotent.
 */
export function registerStandaloneProjectChatIpc(
  options: StandaloneProjectChatIpcOptions,
): boolean {
  const key = options.ipcMain as object
  if (registered.has(key)) return false
  registered.add(key)

  const handle = (channel: string, listener: ProjectIpcHandler): void => {
    options.ipcMain.handle(channel, listener)
  }

  const contexts = registerChatContextIpc({ ipcMain: options.ipcMain, getStore: options.getStore })

  handle('project:resolveChat', (event, value) => {
    const args = value as ResolveChatArgs
    const store = options.getStore()
    store.ensureDefaultProject()
    let filePath = typeof args?.filePath === 'string' ? args.filePath : null
    if (!filePath && args?.sessionId && options.resolveSessionPath) {
      filePath = options.resolveSessionPath(event.sender.id, args.sessionId)
    }
    if (!filePath) {
      return contexts.bind(event, {
        projectId: 'default',
        chatId: args?.tempChatId ?? `unsaved-${(options.now ?? Date.now)()}`,
      })
    }
    return contexts.bind(
      event,
      store.resolveManagedConversation?.(filePath) ?? store.resolveChatForFile(filePath),
      filePath,
    )
  })

  handle('project:appendChat', (event, value) => {
    const args = value as AppendChatArgs
    const message: Parameters<ProjectStore['appendChatMessage']>[2] = {
      role: args.role,
      text: args.text,
    }
    if (args.tools) message.tools = args.tools
    if (args.attachments) message.attachments = args.attachments
    const store = options.getStore(),
      source = { type: 'chat' as const, projectId: args.projectId, chatId: args.chatId }
    if (store.managedSessions?.wasDestroyed(source))
      throw new Error('This conversation was permanently removed.')
    const managed = store.managedSessions?.findSource(source)
    if (managed && managed.state !== 'active')
      throw new Error('Restore this conversation before continuing.')
    store.appendChatMessage(args.projectId, args.chatId, message)
    store.syncManagedTranscript?.(
      args.projectId,
      args.chatId,
      contexts.current(event.sender.id)?.filePath,
    )
  })

  handle('project:loadChat', (_event, value) => {
    const args = value as LoadChatArgs
    const store = options.getStore()
    return (
      store.conversationTranscript?.(args.projectId, args.chatId, args.limit ?? 200) ??
      store.loadChat(args.projectId, args.chatId, args.limit ?? 200)
    )
  })

  handle('project:rebindChat', (event, value) => {
    const args = value as RebindChatArgs
    const store = options.getStore()
    let filePath = args.newFilePath ?? null
    if (!filePath && args.sessionId && options.resolveSessionPath) {
      filePath = options.resolveSessionPath(event.sender.id, args.sessionId)
    }
    if (filePath)
      return contexts.bind(
        event,
        store.rebindManagedConversation?.(args.projectId, args.tempChatId, filePath) ??
          store.rebindChatToFile(args.projectId, args.tempChatId, filePath),
        filePath,
      )
    if (args.newChatId) store.rebindChat(args.projectId, args.tempChatId, args.newChatId)
    return { projectId: args.projectId, chatId: args.newChatId ?? args.tempChatId }
  })

  return true
}
