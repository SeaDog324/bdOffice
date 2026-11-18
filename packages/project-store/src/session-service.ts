import type { ManagedSessionStore } from './session-store.js'
import {
  parseSessionCommand,
  SessionCommandError,
  type SessionActor,
  type SessionCommandReceipt,
  type SessionPermission,
} from './session-command-types.js'
import type { SessionListFilter, SessionView } from './session-types.js'

function requirePermission(actor: SessionActor, permission: SessionPermission): void {
  if (
    !actor ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(actor.principalId) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(actor.deviceId) ||
    !Array.isArray(actor.permissions) ||
    !actor.permissions.includes(permission)
  )
    throw new SessionCommandError(
      'FORBIDDEN',
      'This device is not authorized for this Session operation.',
    )
}
/** One command boundary for trusted IPC and authenticated Remote adapters. */
export class SessionService {
  constructor(
    private readonly store: ManagedSessionStore,
    private readonly options: {
      unavailable?(id: string): boolean
      writeUnavailable?(id: string): boolean
    } = {},
  ) {}
  private available(id: string): void {
    if (this.options.unavailable?.(id))
      throw new SessionCommandError(
        'SESSION_NOT_FOUND',
        'This Session is being permanently removed.',
      )
  }
  projects(actor: SessionActor) {
    requirePermission(actor, 'sessions:read')
    return this.store.projects()
  }
  list(actor: SessionActor, filter?: SessionListFilter) {
    requirePermission(actor, 'sessions:read')
    if (!actor.permissions.includes('memory:read')) {
      const { query, ...catalogFilter } = filter ?? {}
      return this.store
        .list(catalogFilter)
        .filter(
          (meta) => !query || meta.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
        .map(
          ({
            summaryPreview: _summary,
            memoryPreview: _memory,
            outcomePreview: _outcomes,
            ...meta
          }) => ({ ...meta, summaryPreview: '' }),
        )
    }
    return this.store.list(filter)
  }
  get(actor: SessionActor, id: string): SessionView {
    requirePermission(actor, 'sessions:read')
    requirePermission(actor, 'memory:read')
    this.available(id)
    return this.store.get(id)
  }
  execute(actor: SessionActor, input: unknown): SessionCommandReceipt {
    requirePermission(actor, 'sessions:write')
    const command = parseSessionCommand(input)
    const blocked = (id: string) =>
      this.store.writeBlocked(id) || this.options.writeUnavailable?.(id)
    if (
      (command.kind === 'create' && command.parentId && blocked(command.parentId)) ||
      (command.kind !== 'create' &&
        !['trash', 'restore', 'archive'].includes(command.kind) &&
        this.store.scope(command.sessionId).some((meta) => blocked(meta.id)))
    )
      throw new SessionCommandError(
        'SESSION_BUSY',
        'This Session is being transferred or belongs to another execution Host.',
      )
    if (command.kind === 'update_memory' || command.kind === 'set_memory_enabled')
      requirePermission(actor, 'memory:write')
    if (command.kind !== 'create') {
      for (const meta of this.store.scope(command.sessionId)) this.available(meta.id)
    } else if (command.parentId) this.available(command.parentId)
    return this.store.executeCommand(JSON.stringify([actor.principalId, actor.deviceId]), command)
  }
}
