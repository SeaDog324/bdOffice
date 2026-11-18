import { SessionCommandError, type SessionActor } from './session-command-types.js'
import type { SessionService } from './session-service.js'
import type { ManagedSessionMeta, SessionListFilter } from './session-types.js'

export const SESSION_RPC_VERSION = 1
export const SESSION_RPC_METHODS = [
  'capabilities',
  'projects.list',
  'sessions.list',
  'sessions.get',
  'sessions.command',
] as const
export type SessionRpcReply =
  | { version: 1; id: string; ok: true; value: unknown }
  | {
      version: 1
      id: string
      ok: false
      error: {
        code: string
        message: string
        currentVersion?: import('./session-command-types.js').SessionVersion
      }
    }
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SessionCommandError('INVALID_COMMAND', 'Expected an object.')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new SessionCommandError('INVALID_COMMAND', 'Unexpected request field.')
}
function projection(meta: ManagedSessionMeta) {
  return {
    id: meta.id,
    title: meta.title,
    projectId: meta.projectId,
    parentId: meta.parentId,
    kind: meta.kind,
    state: meta.state,
    phase: meta.phase,
    revision: meta.revision,
    updatedAt: meta.updatedAt,
    memoryEnabled: !meta.memoryDisabled,
  }
}

/** The transport owns authentication and revocation. Neither identity nor authority is accepted from JSON. */
export function createSessionRpcHandler(
  service: SessionService,
  authenticatedActor: () => SessionActor | null,
) {
  return (input: unknown): SessionRpcReply => {
    let id = ''
    try {
      const request = row(input)
      keys(request, ['version', 'id', 'method', 'params'])
      if (
        request.version !== 1 ||
        typeof request.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(request.id)
      )
        throw new SessionCommandError('INVALID_COMMAND', 'Invalid RPC envelope.')
      id = request.id
      const actor = authenticatedActor()
      if (!actor)
        throw new SessionCommandError(
          'FORBIDDEN',
          'The authenticated connection is no longer active.',
        )
      const params = row(request.params ?? {})
      let value: unknown
      switch (request.method) {
        case 'capabilities':
          keys(params, [])
          service.projects(actor)
          value = {
            protocol: 'bigdog.session.v1',
            methods: SESSION_RPC_METHODS,
            events: false,
            taskSubmission: false,
          }
          break
        case 'projects.list':
          keys(params, [])
          value = service.projects(actor).map(({ id, name }) => ({ id, name }))
          break
        case 'sessions.list': {
          keys(params, ['state', 'kind', 'projectId', 'query', 'offset', 'limit'])
          const offset = params.offset ?? 0,
            limit = params.limit ?? 50
          if (
            !Number.isSafeInteger(offset) ||
            (offset as number) < 0 ||
            (offset as number) > 100_000 ||
            !Number.isSafeInteger(limit) ||
            (limit as number) < 1 ||
            (limit as number) > 100 ||
            (params.state !== undefined &&
              !['active', 'archived', 'trashed', 'all'].includes(String(params.state))) ||
            (params.kind !== undefined &&
              !['workspace', 'file', 'home'].includes(String(params.kind))) ||
            (params.projectId !== undefined &&
              (typeof params.projectId !== 'string' ||
                !/^[a-zA-Z0-9_-]{1,128}$/.test(params.projectId))) ||
            (params.query !== undefined &&
              (typeof params.query !== 'string' || params.query.length > 200))
          )
            throw new SessionCommandError('INVALID_COMMAND', 'Invalid Session list bounds.')
          const { offset: _offset, limit: _limit, ...filter } = params
          const all = service.list(actor, filter as SessionListFilter)
          value = {
            total: all.length,
            offset,
            sessions: all
              .slice(offset as number, (offset as number) + (limit as number))
              .map(projection),
          }
          break
        }
        case 'sessions.get': {
          keys(params, ['sessionId'])
          if (typeof params.sessionId !== 'string' || !/^[0-9a-f-]{20,64}$/i.test(params.sessionId))
            throw new SessionCommandError('INVALID_COMMAND', 'Invalid Session identifier.')
          const view = service.get(actor, params.sessionId)
          value = {
            session: projection(view.session.meta),
            version: view.version,
            memory: { markdown: view.markdown, mode: view.session.summary.mode },
          }
          break
        }
        case 'sessions.command':
          value = service.execute(actor, params)
          break
        default:
          return {
            version: 1,
            id,
            ok: false,
            error: {
              code: 'METHOD_NOT_SUPPORTED',
              message: 'This host does not support that Session method.',
            },
          }
      }
      return { version: 1, id, ok: true, value }
    } catch (error) {
      if (error instanceof SessionCommandError)
        return {
          version: 1,
          id,
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.currentVersion ? { currentVersion: error.currentVersion } : {}),
          },
        }
      const missing = error instanceof Error && error.message === 'Unknown session.'
      return {
        version: 1,
        id,
        ok: false,
        error: {
          code: missing ? 'SESSION_NOT_FOUND' : 'COMMAND_REJECTED',
          message: missing
            ? 'This Session no longer exists.'
            : 'The Session operation could not be completed. Refresh and try again.',
        },
      }
    }
  }
}
