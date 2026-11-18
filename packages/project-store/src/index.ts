export { ProjectStore, canonicalPathKey } from './store.js'
export { SessionService } from './session-service.js'
export { createSessionRpcHandler, SESSION_RPC_VERSION, SESSION_RPC_METHODS } from './session-rpc.js'
export type { SessionRpcReply } from './session-rpc.js'
export {
  SessionCommandError,
  parseSessionCommand,
  parseSessionVersion,
} from './session-command-types.js'
export type {
  SessionVersion,
  SessionMutationOptions,
  SessionCommand,
  SessionCommandReceipt,
  SessionActor,
  SessionPermission,
} from './session-command-types.js'
export { registerStandaloneProjectChatIpc } from './electron-ipc.js'
export type {
  ProjectIpcEventLike,
  ProjectIpcHandler,
  ProjectIpcMainLike,
  StandaloneProjectChatIpcOptions,
} from './electron-ipc.js'
export type {
  ChatMessage,
  ChatMeta,
  ChatScope,
  ProjectData,
  ProjectIndex,
  ProjectInfo,
  ProjectSummary,
  TimelineEntry,
  ToolActivity,
} from './types.js'
export type {
  AppendChatArgs,
  LoadChatArgs,
  ProjectApi,
  ConversationApi,
  RebindChatArgs,
  ResolveChatArgs,
  ResolveChatResult,
} from './ipc.js'

export {
  ManagedSessionStore,
  transferredSessionId,
  sessionStoreFor,
  normalizeSessionBudget,
  normalizeSessionContext,
} from './session-store.js'
export type {
  SessionContextSelection,
  SessionMemoryState,
  ManagedProject,
  ManagedSessionMeta,
  ManagedSessionDocument,
  ManagedSessionKind,
  ManagedSessionState,
  SessionSource,
  SessionBundle,
  SessionListFilter,
  SessionView,
  ManagedSessionsApi,
} from './session-types.js'
export { registerChatContextIpc } from './chat-context-ipc.js'
export {
  MAX_MEMORY_OUTCOMES,
  outcomeMemoryText,
  outcomeMemoriesFromRecord,
  normalizeOutcomeMemories,
} from './outcome-memory.js'
export type { OutcomeMemoryEntry, OutcomeDocumentReference } from './outcome-memory.js'
export type { ChatContextController, ChatContextSender } from './chat-context-ipc.js'
export { FILE_TASK_CHANNEL } from './file-task-api.js'
export type {
  FileTaskCall,
  FileTaskItem,
  FileTaskPanelState,
  FileTaskRequests,
  FileTaskReplies,
} from './file-task-api.js'
export {
  normalizePortableResults,
  portableFilename,
  PORTABLE_ARTIFACT_LIMIT,
  PORTABLE_RESULT_LIMIT,
} from './result-evidence.js'
export type {
  PortableResults,
  PortableResultRecord,
  PortableResultFile,
  PortableResultArtifact,
} from './result-evidence.js'
