/** Transport-neutral commands. Actor identity is supplied by the authenticated host, never the wire. */
export interface SessionVersion {
  revision: number
  summaryDigest: string
  treeDigest: string
}
export interface SessionMutationOptions {
  requestId?: string
  expected: SessionVersion
}
interface ExistingCommand {
  requestId: string
  sessionId: string
  expected: SessionVersion
}
export type SessionCommand =
  | { kind: 'create'; requestId: string; title: string; projectId: string; parentId?: string }
  | (ExistingCommand & { kind: 'rename'; title: string })
  | (ExistingCommand & { kind: 'update_memory'; markdown: string })
  | (ExistingCommand & { kind: 'set_memory_enabled'; enabled: boolean })
  | (ExistingCommand & { kind: 'move'; projectId: string; parentId: string | null })
  | (ExistingCommand & { kind: 'archive'; archived: boolean })
  | (ExistingCommand & { kind: 'trash' | 'restore' })

export type SessionPermission = 'sessions:read' | 'sessions:write' | 'memory:read' | 'memory:write'
export interface SessionActor {
  principalId: string
  deviceId: string
  permissions: readonly SessionPermission[]
}
export interface SessionCommandReceipt {
  requestId: string
  sessionId: string
  version: SessionVersion
  affectedSessionIds: string[]
  duplicate: boolean
}
export type SessionCommandErrorCode =
  | 'INVALID_COMMAND'
  | 'FORBIDDEN'
  | 'SESSION_CONFLICT'
  | 'REQUEST_CONFLICT'
  | 'SESSION_BUSY'
  | 'SESSION_NOT_FOUND'
  | 'STORAGE_RECOVERY_REQUIRED'
  | 'COMMAND_TOO_LARGE'

export class SessionCommandError extends Error {
  constructor(
    readonly code: SessionCommandErrorCode,
    message: string,
    readonly currentVersion?: SessionVersion,
  ) {
    super(`${code}: ${message}`)
    this.name = 'SessionCommandError'
  }
}

const identifier = /^[a-zA-Z0-9_-]{1,128}$/
const sessionIdentifier = /^[0-9a-f-]{20,64}$/i
const digest = /^[a-f0-9]{64}$/
function invalid(): never {
  throw new SessionCommandError('INVALID_COMMAND', 'Invalid Session command.')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function key(value: unknown, session = false): string {
  if (
    typeof value !== 'string' ||
    !(session ? sessionIdentifier : identifier).test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    invalid()
  return value
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) invalid()
  return value.trim().replace(/[\r\n\t]+/g, ' ')
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid()
  return value
}
export function parseSessionVersion(value: unknown): SessionVersion {
  const row = object(value)
  if (
    Object.keys(row).some((k) => !['revision', 'summaryDigest', 'treeDigest'].includes(k)) ||
    typeof row.revision !== 'number' ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    typeof row.summaryDigest !== 'string' ||
    !digest.test(row.summaryDigest) ||
    typeof row.treeDigest !== 'string' ||
    !digest.test(row.treeDigest)
  )
    invalid()
  return { revision: row.revision, summaryDigest: row.summaryDigest, treeDigest: row.treeDigest }
}
/** Normalize before fingerprinting so key ordering cannot bypass request deduplication. */
export function parseSessionCommand(value: unknown): SessionCommand {
  const row = object(value)
  const requestId = key(row.requestId)
  const fields: Record<string, string[]> = {
    create: ['title', 'projectId', 'parentId'],
    rename: ['title'],
    update_memory: ['markdown'],
    set_memory_enabled: ['enabled'],
    move: ['projectId', 'parentId'],
    archive: ['archived'],
    trash: [],
    restore: [],
  }
  const kind = row.kind
  if (typeof kind !== 'string' || !Object.hasOwn(fields, kind)) invalid()
  const allowed = [
    'kind',
    'requestId',
    ...fields[kind]!,
    ...(kind === 'create' ? [] : ['sessionId', 'expected']),
  ]
  if (Object.keys(row).some((k) => !allowed.includes(k))) invalid()
  if (kind === 'create')
    return {
      kind,
      requestId,
      title: name(row.title),
      projectId: key(row.projectId),
      ...(row.parentId === undefined ? {} : { parentId: key(row.parentId, true) }),
    }
  const base = {
    requestId,
    sessionId: key(row.sessionId, true),
    expected: parseSessionVersion(row.expected),
  }
  switch (kind) {
    case 'rename':
      return { ...base, kind, title: name(row.title) }
    case 'update_memory':
      if (
        typeof row.markdown !== 'string' ||
        new TextEncoder().encode(row.markdown).length > 256 * 1024
      )
        invalid()
      return { ...base, kind, markdown: row.markdown }
    case 'set_memory_enabled':
      return { ...base, kind, enabled: bool(row.enabled) }
    case 'move':
      return {
        ...base,
        kind,
        projectId: key(row.projectId),
        parentId: row.parentId === null ? null : key(row.parentId, true),
      }
    case 'archive':
      return { ...base, kind, archived: bool(row.archived) }
    case 'trash':
    case 'restore':
      return { ...base, kind }
    default:
      return invalid()
  }
}
