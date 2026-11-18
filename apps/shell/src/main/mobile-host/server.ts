import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname } from 'node:path'
import type { AddressInfo } from 'node:net'
import { RemoteIdentityError, type DeviceProof, type RemoteIdentityStore } from './identity-store'
import type { AssistantTaskAnswer, AssistantTaskControl } from '../../shared/assistant-task-api'
import {
  createSessionRpcHandler,
  type SessionActor,
  type SessionService,
  type ManagedSessionMeta,
  type PortableResults,
} from '@genoffice/project-store'
import type { AssistantTaskView } from '../../shared/assistant-task-api'
import type { WorkspaceAgentEvent } from '../../shared/workspace-agent-api'
import {
  MOBILE_HOST_PROTOCOL,
  type MobileArtifact,
  type MobileMessage,
  type MobileRpcReply,
} from '../../shared/mobile-host-api'

const MAX_BODY = 1024 * 1024
const TOKEN_TTL = 2 * 60 * 60 * 1000
const PAIR_TTL = 5 * 60 * 1000
const ARTIFACT_TTL = 5 * 60 * 1000
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const identity = /^[a-f0-9-]{20,64}$/i
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export interface MobileHostDependencies {
  sessions: SessionService
  session(id: string): ManagedSessionMeta
  history(id: string): Promise<{ messages: Array<{ role: string; text?: string }>; cursor: number }>
  events(id: string): Promise<WorkspaceAgentEvent[]>
  send(
    actor: SessionActor,
    id: string,
    requestId: string,
    text: string,
  ): Promise<{ taskId: string; duplicate: boolean }>
  tasks(id: string): AssistantTaskView[]
  results(id: string): Promise<PortableResults | undefined>
  receipt?(
    actor: SessionActor,
    id: string,
    requestId: string,
  ): { taskId: string; text: string } | null
  control?(id: string, input: AssistantTaskControl): Promise<AssistantTaskView>
  answer?(id: string, input: AssistantTaskAnswer): Promise<AssistantTaskView>
  preview?(name: string, bytes: Buffer): Promise<Buffer>
  permissions?(
    sessionId: string,
    taskId: string,
  ): Array<{ id: string; title: string; description: string }>
  approve?(
    sessionId: string,
    taskId: string,
    confirmationId: string,
    revision: number,
    permissionId: string,
    allowed: boolean,
  ): void
  authorizeWrite?(sessionId: string): Promise<void>
  transfer?(method: string, params: Record<string, unknown>): Promise<unknown>
  prepareExport?(sessionId: string): Promise<void>
  prepareImport?(sessionId: string): Promise<void>
}
interface Credential {
  actor: SessionActor
  expiresAt: number
  deviceRevision?: number
}
interface CachedArtifact extends MobileArtifact {
  body: Buffer
  expiresAt: number
  deviceId: string
  sessionId: string
}
class MobileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MobileError('INVALID_REQUEST', 'Expected an object.')
  return value as Record<string, unknown>
}
function only(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new MobileError('INVALID_REQUEST', 'Unexpected request field.')
}
function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !identity.test(value))
    throw new MobileError('INVALID_SESSION', 'Invalid Session ID.')
  return value
}
function originAllowed(value: string): boolean {
  if (value === 'null') return true
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.origin === value
    )
  } catch {
    return false
  }
}
function mimeFor(name: string): string {
  return (
    (
      {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.md': 'text/plain; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.json': 'application/json',
        '.csv': 'text/csv; charset=utf-8',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      } as Record<string, string>
    )[extname(name).toLowerCase()] ?? 'application/octet-stream'
  )
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
    throw new MobileError('JSON_REQUIRED', 'Use application/json.', 415)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const part = Buffer.from(chunk)
    total += part.length
    if (total > MAX_BODY)
      throw new MobileError('REQUEST_TOO_LARGE', 'Request exceeds the size limit.', 413)
    chunks.push(part)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new MobileError('INVALID_JSON', 'Invalid JSON.')
  }
}

/** Explicit opt-in, loopback-only development gateway for emulator integration. Never logs secrets or request bodies. */
export class MobileDevHost {
  private server: Server | undefined
  private readonly bootId = randomUUID()
  private issuedAt: number
  private codeDigest: Buffer
  private used = false
  private attempts: number[] = []
  private credentials = new Map<string, Credential>()
  private artifacts = new Map<string, CachedArtifact>()
  private submissions = new Map<
    string,
    { text: string; result: Promise<{ taskId: string; duplicate: boolean }> }
  >()
  constructor(
    private readonly dependencies: MobileHostDependencies,
    pairingCode: string,
    private readonly now: () => number = Date.now,
    readonly identities?: RemoteIdentityStore,
  ) {
    if (
      typeof pairingCode !== 'string' ||
      pairingCode.length < 6 ||
      pairingCode.length > 128 ||
      // eslint-disable-next-line no-control-regex -- Reject control bytes at the filesystem/auth boundary.
      /[\x00-\x20\x7f]/.test(pairingCode)
    )
      throw new Error('Mobile development gateway requires a valid pairing code.')
    this.codeDigest = createHash('sha256').update(pairingCode).digest()
    this.issuedAt = now()
  }
  async start(port: number): Promise<number> {
    if (this.server) throw new Error('Mobile gateway already started.')
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('Invalid mobile gateway port.')
    const server = createServer(
      { maxHeaderSize: 8192, requestTimeout: 10_000 },
      (request, response) => {
        void this.handle(request, response).catch((error) => {
          if (response.headersSent) {
            response.destroy()
            return
          }
          const failure =
            error instanceof RemoteIdentityError
              ? new MobileError(error.code, 'Device authorization failed.', 403)
              : error instanceof MobileError
                ? error
                : new MobileError('REQUEST_FAILED', 'The request could not be completed.', 500)
          this.json(response, failure.status, {
            error: { code: failure.code, message: failure.message },
          })
        })
      },
    )
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        this.server = undefined
        reject(error)
      }
      server.once('error', fail)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', fail)
        resolve()
      })
    })
    return (server.address() as AddressInfo).port
  }
  createInvitation() {
    const code = randomBytes(6).toString('hex')
    this.codeDigest = createHash('sha256').update(code).digest()
    this.issuedAt = this.now()
    this.used = false
    return { code, expiresAt: this.issuedAt + PAIR_TTL }
  }
  invitationState(): 'ready' | 'used' | 'expired' {
    return this.used ? 'used' : this.now() >= this.issuedAt + PAIR_TTL ? 'expired' : 'ready'
  }
  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.credentials.clear()
    this.artifacts.clear()
    this.submissions.clear()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  private json(response: ServerResponse, status: number, value: unknown): void {
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length > 2 * 1024 * 1024) {
      response.writeHead(413, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: { code: 'RESPONSE_TOO_LARGE', message: 'Response exceeds the development limit.' },
        }),
      )
      return
    }
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': bytes.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(bytes)
  }
  private authorize(request: IncomingMessage): Credential {
    const auth = request.headers.authorization
    if (typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{40,128}$/.test(auth))
      throw new MobileError('UNAUTHORIZED', 'Pair this device first.', 401)
    const key = digest(auth.slice(7)),
      credential = this.credentials.get(key)
    if (
      !credential ||
      credential.expiresAt <= this.now() ||
      (credential.deviceRevision !== undefined &&
        this.identities?.revision(credential.actor.deviceId) !== credential.deviceRevision)
    ) {
      this.credentials.delete(key)
      throw new MobileError('UNAUTHORIZED', 'The device credential is expired or unavailable.', 401)
    }
    return credential
  }
  private requireSession(id: string): ManagedSessionMeta {
    let meta: ManagedSessionMeta
    try {
      meta = this.dependencies.session(id)
    } catch {
      throw new MobileError('SESSION_NOT_FOUND', 'This Session no longer exists.', 404)
    }
    if (meta.state === 'trashed')
      throw new MobileError('SESSION_INACTIVE', 'Restore the Session before accessing it.', 409)
    return meta
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host
    const hosts = request.rawHeaders.filter(
      (_, i, all) => i % 2 === 0 && all[i]!.toLowerCase() === 'host',
    ).length
    const authCount = request.rawHeaders.filter(
      (_, i, all) => i % 2 === 0 && all[i]!.toLowerCase() === 'authorization',
    ).length
    if (
      hosts !== 1 ||
      authCount > 1 ||
      typeof host !== 'string' ||
      !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/.test(host)
    )
      throw new MobileError('INVALID_HOST', 'A loopback Host is required.', 403)
    const origin = request.headers.origin
    if (origin !== undefined) {
      if (!originAllowed(origin))
        throw new MobileError('INVALID_ORIGIN', 'This development origin is not allowed.', 403)
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
        'access-control-max-age': '300',
      })
      response.end()
      return
    }
    if (!request.url?.startsWith('/'))
      throw new MobileError('INVALID_REQUEST', 'Invalid request target.')
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.search || url.hash)
      throw new MobileError('INVALID_REQUEST', 'Query credentials and parameters are not accepted.')
    if (request.method === 'GET' && ['/health', '/mobile/v1/health'].includes(url.pathname)) {
      this.json(response, 200, {
        ok: true,
        protocol: MOBILE_HOST_PROTOCOL,
        mode: 'loopback-development',
        instanceId: this.bootId,
        hostId: this.identities?.hostId,
        durableIdentity: Boolean(this.identities),
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/mobile/v1/challenge' && this.identities) {
      const value = object(await body(request))
      only(value, ['publicKey', 'purpose'])
      this.json(response, 200, this.identities.challenge(value.publicKey, value.purpose))
      return
    }
    if (request.method === 'POST' && url.pathname === '/mobile/v1/resume' && this.identities) {
      const value = object(await body(request))
      only(value, ['proof'])
      const device = this.identities.authenticate(value.proof as DeviceProof, 'resume')
      this.json(response, 200, this.issueCredential(device.deviceId, device.revision))
      return
    }
    if (request.method === 'POST' && url.pathname === '/mobile/v1/pair') {
      this.attempts = this.attempts.filter((at) => at > this.now() - 60_000)
      if (this.attempts.length >= 5)
        throw new MobileError('PAIRING_RATE_LIMIT', 'Too many pairing attempts. Retry later.', 429)
      this.attempts.push(this.now())
      if (this.used)
        throw new MobileError('PAIRING_USED', 'This pairing invitation was already used.', 409)
      if (this.now() - this.issuedAt > PAIR_TTL)
        throw new MobileError('PAIRING_EXPIRED', 'This pairing invitation expired.', 410)
      const value = object(await body(request))
      only(value, ['code', 'deviceName', 'proof'])
      if (
        typeof value.code !== 'string' ||
        value.code.length > 128 ||
        typeof value.deviceName !== 'string' ||
        !value.deviceName.trim() ||
        value.deviceName.length > 80
      )
        throw new MobileError('INVALID_REQUEST', 'Invalid pairing request.')
      if (!timingSafeEqual(createHash('sha256').update(value.code).digest(), this.codeDigest))
        throw new MobileError('PAIRING_REFUSED', 'Pairing code is incorrect.', 403)
      // Recheck after the async body read: simultaneous callers cannot both consume one invitation.
      if (this.used)
        throw new MobileError('PAIRING_USED', 'This pairing invitation was already used.', 409)
      if (this.now() - this.issuedAt > PAIR_TTL)
        throw new MobileError('PAIRING_EXPIRED', 'This pairing invitation expired.', 410)
      const device = this.identities?.authenticate(
        value.proof as DeviceProof,
        'pair',
        value.deviceName,
      )
      this.used = true
      this.json(
        response,
        200,
        this.issueCredential(device?.deviceId ?? randomUUID(), device?.revision),
      )
      return
    }
    const credential = this.authorize(request)
    if (request.method === 'POST' && url.pathname === '/mobile/v1/rpc') {
      const input = await body(request)
      // A body may finish after expiry or shutdown.
      this.authorize(request)
      const reply = await this.rpc(credential.actor, input)
      this.authorize(request)
      this.json(response, 200, reply)
      return
    }
    const match = /^\/mobile\/v1\/artifacts\/([a-f0-9-]{20,64})\/([a-f0-9-]{20,64})$/i.exec(
      url.pathname,
    )
    if (request.method === 'GET' && match) {
      const id = sessionId(match[1])
      this.requireSession(id)
      this.pruneArtifacts()
      const artifact = this.artifacts.get(`${credential.actor.deviceId}:${id}:${match[2]}`)
      if (!artifact)
        throw new MobileError(
          'ARTIFACT_NOT_FOUND',
          'Refresh the result manifest before downloading.',
          404,
        )
      response.writeHead(200, {
        'content-type': artifact.mime,
        'content-length': artifact.body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        etag: `"${artifact.digest}"`,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
      })
      response.end(artifact.body)
      return
    }
    throw new MobileError('NOT_FOUND', 'Unknown mobile development endpoint.', 404)
  }
  private issueCredential(deviceId: string, deviceRevision?: number) {
    const token = randomBytes(32).toString('base64url'),
      expiresAt = this.now() + TOKEN_TTL
    this.credentials.set(digest(token), {
      actor: {
        principalId: 'mobile-dev-owner',
        deviceId,
        permissions: ['sessions:read', 'sessions:write', 'memory:read', 'memory:write'],
      },
      expiresAt,
      deviceRevision,
    })
    return { token, deviceId, expiresAt, hostId: this.identities?.hostId }
  }
  private async rpc(actor: SessionActor, input: unknown): Promise<MobileRpcReply> {
    let id = ''
    try {
      const request = object(input)
      only(request, ['version', 'id', 'method', 'params'])
      if (
        request.version !== 1 ||
        typeof request.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(request.id) ||
        typeof request.method !== 'string'
      )
        throw new MobileError('INVALID_REQUEST', 'Invalid RPC envelope.')
      id = request.id
      if (
        [
          'handoff.prepare',
          'handoff.read',
          'handoff.upload',
          'handoff.accept',
          'handoff.finalize',
        ].includes(request.method)
      ) {
        const params = object(request.params)
        if (!this.dependencies.transfer)
          throw new MobileError('REMOTE_REQUIRED', 'Configure the remote coordinator first.')
        if (['handoff.prepare', 'handoff.read', 'handoff.finalize'].includes(request.method)) {
          const meta = this.dependencies.session(sessionId(params.sessionId))
          if (meta.state === 'trashed')
            throw new MobileError('SESSION_INACTIVE', 'Restore the Session first.')
        }
        const value = await this.dependencies.transfer(request.method, params)
        return { version: 1, id, ok: true, value }
      }
      if (
        ['projects.list', 'sessions.list', 'sessions.get', 'sessions.command'].includes(
          request.method,
        )
      ) {
        const command = request.method === 'sessions.command' ? object(request.params) : undefined
        if (command?.sessionId)
          await this.dependencies.authorizeWrite?.(sessionId(command.sessionId))
        const reply = await createSessionRpcHandler(this.dependencies.sessions, () => actor)(input)
        if (reply.ok && request.method === 'sessions.list') {
          const result = reply.value as { sessions: ManagedSessionMeta[] }
          return {
            ...reply,
            value: {
              ...result,
              sessions: result.sessions.map((meta) => {
                const tasks = this.dependencies.tasks(meta.id)
                const task = tasks.find((item) => item.state === 'waiting_user')
                return {
                  ...meta,
                  canSend: meta.kind !== 'file',
                  preview: tasks[0]?.title.slice(0, 100),
                  attention: task
                    ? { taskId: task.id, title: task.title, state: task.state }
                    : undefined,
                }
              }),
            },
          }
        }
        if (
          reply.ok &&
          command?.kind === 'create' &&
          typeof (reply.value as { sessionId?: unknown })?.sessionId === 'string'
        ) {
          await this.dependencies.authorizeWrite?.((reply.value as { sessionId: string }).sessionId)
          await this.dependencies.prepareImport?.((reply.value as { sessionId: string }).sessionId)
        }
        return reply
      }
      if (
        ![
          'capabilities',
          'messages.history',
          'messages.send',
          'messages.receipt',
          'events.poll',
          'tasks.list',
          'tasks.control',
          'tasks.answer',
          'tasks.approve',
          'notices.list',
          'notices.ack',
          'results.list',
          'artifacts.read',
          'artifacts.preview',
        ].includes(request.method)
      )
        throw new MobileError('METHOD_NOT_SUPPORTED', 'Unsupported mobile method.')
      const params = object(request.params ?? {})
      let value: unknown
      if (request.method === 'capabilities') {
        only(params, [])
        value = {
          protocol: 'bigdog.session.v1',
          development: true,
          events: 'poll',
          taskSubmission: true,
          fileConversationSending: false,
          methods: [
            'capabilities',
            'projects.list',
            'sessions.list',
            'sessions.get',
            'sessions.command',
            'messages.history',
            'messages.send',
            'messages.receipt',
            'events.poll',
            'tasks.list',
            'tasks.control',
            'tasks.answer',
            'tasks.approve',
            'notices.list',
            'notices.ack',
            'results.list',
            'artifacts.read',
            'artifacts.preview',
          ],
        }
      } else {
        const sid = sessionId(params.sessionId),
          meta = this.requireSession(sid)
        switch (request.method) {
          case 'messages.history': {
            only(params, ['sessionId', 'limit', 'beforeOffset'])
            const limit = params.limit ?? 100,
              offset = params.beforeOffset ?? 0
            if (
              !Number.isSafeInteger(limit) ||
              (limit as number) < 1 ||
              (limit as number) > 200 ||
              !Number.isSafeInteger(offset) ||
              (offset as number) < 0 ||
              (offset as number) > 100_000
            )
              throw new MobileError('INVALID_REQUEST', 'Invalid history bounds.')
            const history = await this.dependencies.history(sid)
            this.requireSession(sid)
            const rows = history.messages.filter(
              (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string',
            )
            const end = Math.max(0, rows.length - (offset as number)),
              start = Math.max(0, end - (limit as number))
            const messages: MobileMessage[] = rows.slice(start, end).map((m, index) => ({
              id: digest(JSON.stringify([sid, start + index, m.role, m.text])),
              role: m.role as 'user' | 'assistant',
              text: m.text!.slice(0, 32_000),
              at: null,
            }))
            value = {
              messages,
              cursor: history.cursor,
              hasMore: start > 0,
              nextOffset: rows.length - start,
            }
            break
          }
          case 'messages.send': {
            only(params, ['sessionId', 'requestId', 'text'])
            if (meta.kind === 'file')
              throw new MobileError(
                'EDITOR_REQUIRED',
                'Continue this file conversation in its desktop editor.',
                409,
              )
            if (meta.state !== 'active')
              throw new MobileError('SESSION_INACTIVE', 'Restore the Session before sending.', 409)
            if (
              typeof params.requestId !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,128}$/.test(params.requestId) ||
              typeof params.text !== 'string' ||
              !params.text.trim() ||
              params.text.length > 32_000
            )
              throw new MobileError('INVALID_REQUEST', 'Invalid message.')
            const key = JSON.stringify([actor.principalId, actor.deviceId, sid, params.requestId]),
              text = params.text.trim()
            const persisted = this.identities?.receipt(actor.deviceId, sid, params.requestId, text)
            const accepted = this.dependencies.receipt?.(actor, sid, params.requestId)
            if (accepted && accepted.text !== text)
              throw new RemoteIdentityError('REQUEST_CONFLICT')
            if (persisted || accepted) {
              value = persisted ?? { taskId: accepted!.taskId, duplicate: true }
              if (accepted)
                this.identities?.record(
                  actor.deviceId,
                  sid,
                  params.requestId,
                  text,
                  accepted.taskId,
                )
              break
            }
            await this.dependencies.authorizeWrite?.(sid)
            const previous = this.submissions.get(key)
            if (previous) {
              if (previous.text !== text)
                throw new MobileError(
                  'REQUEST_CONFLICT',
                  'A request ID cannot be reused for different text.',
                  409,
                )
              value = { ...(await previous.result), duplicate: true }
            } else {
              if (this.submissions.size >= 4096)
                throw new MobileError(
                  'SESSION_LIMIT',
                  'Restart and pair again to continue this development session.',
                  429,
                )
              // Retain the pending promise too: retries during preparation cannot queue a second task.
              const result = this.dependencies.send(actor, sid, params.requestId, text)
              this.submissions.set(key, { text, result })
              // Keep failures as well: an executor may have accepted a clarification before
              // a later persistence failure. Retrying that request must never start a new task.
              value = await result
            }
            this.identities?.record(
              actor.deviceId,
              sid,
              params.requestId,
              text,
              (value as { taskId: string }).taskId,
            )
            break
          }
          case 'messages.receipt': {
            only(params, ['sessionId', 'requestId'])
            if (
              typeof params.requestId !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,128}$/.test(params.requestId)
            )
              throw new MobileError('INVALID_REQUEST', 'Invalid request ID.')
            const receipt = this.identities?.receipt(actor.deviceId, sid, params.requestId)
            const accepted = this.dependencies.receipt?.(actor, sid, params.requestId)
            value = receipt ?? (accepted ? { taskId: accepted.taskId, duplicate: true } : null)
            break
          }
          case 'tasks.control':
          case 'tasks.answer': {
            const answer = request.method === 'tasks.answer'
            only(
              params,
              answer
                ? [
                    'sessionId',
                    'taskId',
                    'requestId',
                    'expectedRevision',
                    'confirmationId',
                    'answer',
                  ]
                : ['sessionId', 'taskId', 'requestId', 'expectedRevision', 'action', 'reviewed'],
            )
            if (
              typeof params.taskId !== 'string' ||
              typeof params.requestId !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,128}$/.test(params.requestId) ||
              !Number.isSafeInteger(params.expectedRevision) ||
              (params.expectedRevision as number) < 0
            )
              throw new MobileError('INVALID_REQUEST', 'Invalid task decision.')
            if (!this.dependencies.tasks(sid).some((t) => t.id === params.taskId))
              throw new MobileError('TASK_NOT_FOUND', 'Task does not belong to this Session.')
            const requestId = digest(
              JSON.stringify([actor.deviceId, sid, request.method, params.requestId]),
            )
            if (answer) {
              if (
                typeof params.confirmationId !== 'string' ||
                typeof params.answer !== 'string' ||
                !params.answer.trim() ||
                params.answer.length > 8000 ||
                !this.dependencies.answer
              )
                throw new MobileError('INVALID_REQUEST', 'Invalid answer.')
              value = await this.dependencies.answer(sid, {
                taskId: params.taskId,
                requestId,
                expectedRevision: params.expectedRevision as number,
                confirmationId: params.confirmationId,
                answer: params.answer,
              })
            } else {
              if (
                !['pause', 'resume', 'cancel', 'retry', 'reconcile'].includes(
                  String(params.action),
                ) ||
                (params.reviewed !== undefined && typeof params.reviewed !== 'boolean') ||
                !this.dependencies.control
              )
                throw new MobileError('INVALID_REQUEST', 'Invalid task control.')
              value = await this.dependencies.control(sid, {
                taskId: params.taskId,
                requestId,
                expectedRevision: params.expectedRevision as number,
                action: params.action as AssistantTaskControl['action'],
                reviewed: params.reviewed as boolean | undefined,
              })
            }
            break
          }
          case 'notices.list': {
            only(params, ['sessionId'])
            value = {
              notices: this.dependencies
                .tasks(sid)
                .filter((t) =>
                  ['completed', 'failed', 'waiting_user', 'interrupted'].includes(t.state),
                )
                .map((t) => ({
                  id: `${t.id}:${t.revision}`,
                  taskId: t.id,
                  state: t.state,
                  title: t.title,
                  revision: t.revision,
                }))
                .filter((n) => !this.identities?.acknowledged(actor.deviceId, n.id))
                .slice(0, 100),
            }
            break
          }
          case 'notices.ack': {
            only(params, ['sessionId', 'noticeId'])
            if (
              typeof params.noticeId !== 'string' ||
              !this.dependencies.tasks(sid).some((t) => `${t.id}:${t.revision}` === params.noticeId)
            )
              throw new MobileError('INVALID_REQUEST', 'Unknown notice revision.')
            this.identities?.acknowledge(actor.deviceId, params.noticeId)
            value = { acknowledged: true }
            break
          }
          case 'events.poll': {
            only(params, ['sessionId', 'afterSequence'])
            const after = params.afterSequence ?? 0
            if (!Number.isSafeInteger(after) || (after as number) < 0)
              throw new MobileError('INVALID_REQUEST', 'Invalid event cursor.')
            if (meta.kind === 'file') {
              value = { events: [], cursor: 0, resyncRequired: (after as number) !== 0 }
              break
            }
            const all = await this.dependencies.events(sid),
              sequences = all
                .map((e) => e.sequence)
                .filter((n): n is number => typeof n === 'number')
            const latest = Math.max(0, ...sequences),
              earliest = sequences.length ? Math.min(...sequences) : 0
            const resyncRequired = (after as number) > latest || earliest > (after as number) + 1
            const selected = all.filter((e) => (e.sequence ?? 0) > (after as number)).slice(0, 200)
            const events = selected.map((e) => ({
              id: e.id,
              sessionId: sid,
              sequence: e.sequence,
              type: e.type,
              timestamp: e.timestamp,
              runId: e.runId,
              role: e.role,
              text: e.text?.slice(0, 16_000),
              status: e.status,
              error: e.error?.slice(0, 500),
              tool: e.tool
                ? {
                    callId: e.tool.callId,
                    name: e.tool.name,
                    summary: e.tool.summary?.slice(0, 500),
                    error: e.tool.error,
                    mutated: e.tool.mutated,
                  }
                : undefined,
            }))
            value = {
              events: resyncRequired ? [] : events,
              cursor: resyncRequired ? latest : (selected.at(-1)?.sequence ?? latest),
              resyncRequired,
            }
            break
          }
          case 'tasks.list':
            only(params, ['sessionId'])
            value = {
              tasks: this.dependencies
                .tasks(sid)
                .slice(0, 100)
                .map((task) => ({
                  ...task,
                  permissions: this.dependencies.permissions?.(sid, task.id) ?? [],
                })),
            }
            break
          case 'tasks.approve': {
            only(params, [
              'sessionId',
              'taskId',
              'confirmationId',
              'expectedRevision',
              'permissionId',
              'allowed',
            ])
            if (
              typeof params.taskId !== 'string' ||
              typeof params.confirmationId !== 'string' ||
              typeof params.permissionId !== 'string' ||
              typeof params.allowed !== 'boolean' ||
              !Number.isSafeInteger(params.expectedRevision) ||
              !this.dependencies.approve
            )
              throw new MobileError('INVALID_REQUEST', 'Invalid approval.')
            this.dependencies.approve(
              sid,
              params.taskId,
              params.confirmationId,
              params.expectedRevision as number,
              params.permissionId,
              params.allowed,
            )
            value = { received: true }
            break
          }
          case 'results.list':
            only(params, ['sessionId'])
            value = await this.results(actor, sid)
            break
          case 'artifacts.read':
          case 'artifacts.preview': {
            const preview = request.method === 'artifacts.preview'
            only(
              params,
              preview ? ['sessionId', 'artifactId'] : ['sessionId', 'artifactId', 'offset'],
            )
            if (typeof params.artifactId !== 'string' || !/^[a-f0-9]{64}$/.test(params.artifactId))
              throw new MobileError('INVALID_REQUEST', 'Invalid artifact ID.')
            this.pruneArtifacts()
            const source = this.artifacts.get(`${actor.deviceId}:${sid}:${params.artifactId}`)
            if (!source) throw new MobileError('ARTIFACT_NOT_FOUND', 'Refresh the manifest first.')
            if (!preview) {
              const offset = params.offset ?? 0
              if (
                !Number.isSafeInteger(offset) ||
                (offset as number) < 0 ||
                (offset as number) > source.bytes
              )
                throw new MobileError('INVALID_REQUEST', 'Invalid artifact offset.')
              const end = Math.min(source.bytes, (offset as number) + 192 * 1024)
              value = {
                base64: source.body.subarray(offset as number, end).toString('base64'),
                nextOffset: end,
                done: end === source.bytes,
                digest: source.digest,
                bytes: source.bytes,
              }
            } else if (source.mime === 'application/pdf')
              value = {
                id: source.id,
                name: source.name,
                mime: source.mime,
                bytes: source.bytes,
                digest: source.digest,
              }
            else {
              if (!/\.(docx|xlsx|pptx|md|html?)$/i.test(source.name) || !this.dependencies.preview)
                throw new MobileError(
                  'PREVIEW_UNSUPPORTED',
                  'Preview is unavailable for this file.',
                )
              let body: Buffer
              try {
                body = await this.dependencies.preview(source.name, source.body)
              } catch {
                throw new MobileError('PREVIEW_FAILED', 'The Host could not convert this artifact.')
              }
              this.requireSession(sid)
              if (
                body.length > MAX_ARTIFACT_BYTES ||
                !body.subarray(0, 5).equals(Buffer.from('%PDF-'))
              )
                throw new MobileError('PREVIEW_FAILED', 'Invalid PDF preview.')
              const name = source.name + '.pdf',
                hash = digest(body),
                id = digest(JSON.stringify([name, hash]))
              const artifact = {
                id,
                name,
                mime: 'application/pdf',
                bytes: body.length,
                digest: hash,
              }
              this.artifacts.set(`${actor.deviceId}:${sid}:${id}`, {
                ...artifact,
                body,
                expiresAt: this.now() + ARTIFACT_TTL,
                deviceId: actor.deviceId,
                sessionId: sid,
              })
              this.pruneArtifacts()
              value = artifact
            }
            break
          }
          default:
            throw new MobileError('METHOD_NOT_SUPPORTED', 'Unsupported mobile method.')
        }
      }
      return { version: 1, id, ok: true, value }
    } catch (error) {
      const failure =
        error instanceof RemoteIdentityError
          ? new MobileError(error.code, 'The device or request could not be verified.')
          : error instanceof MobileError
            ? error
            : new MobileError(
                error instanceof Error &&
                  [
                    'OWNER_CHANGED',
                    'SESSION_BUSY',
                    'HANDOFF_TOO_LARGE',
                    'HANDOFF_CORRUPT',
                    'HANDOFF_OFFSET',
                    'INVALID_HANDOFF',
                    'LEASE_EXPIRED',
                    'REQUEST_CONFLICT',
                    'STALE_TASK_APPROVAL',
                    'stale_task_revision',
                    'task_budget_exhausted',
                    'task_cannot_resume',
                    'task_context_changed',
                    'task_effect_requires_review',
                    'task_conversation_changed',
                    'task_provider_changed',
                  ].includes(error.message)
                  ? error.message
                  : 'REQUEST_FAILED',
                'The Session operation could not be completed.',
              )
      return { version: 1, id, ok: false, error: { code: failure.code, message: failure.message } }
    }
  }
  private pruneArtifacts(): void {
    for (const [key, value] of this.artifacts)
      if (value.expiresAt <= this.now()) this.artifacts.delete(key)
    let total = [...this.artifacts.values()].reduce((sum, item) => sum + item.bytes, 0)
    for (const [key, value] of this.artifacts) {
      if (total <= MAX_CACHE_BYTES) break
      this.artifacts.delete(key)
      total -= value.bytes
    }
  }
  async acceptOffline(
    peerId: string,
    peerKey: string,
    sessionId: string,
    requestId: string,
    text: string,
  ) {
    if (!this.identities) throw new Error('DURABLE_IDENTITY_REQUIRED')
    const deviceId = this.identities.carrierDevice(peerId, peerKey)
    const result = await this.rpc(
      {
        principalId: 'mobile-dev-owner',
        deviceId,
        permissions: ['sessions:read', 'sessions:write', 'memory:read', 'memory:write'],
      },
      {
        version: 1,
        id: requestId,
        method: 'messages.send',
        params: { sessionId, requestId, text },
      },
    )
    if (!result.ok) throw new Error(result.error.code)
    return result.value as { taskId: string; duplicate: boolean }
  }
  exportResults(sessionId: string) {
    this.requireSession(sessionId)
    return this.dependencies.results(sessionId)
  }
  prepareExport(sessionId: string) {
    this.requireSession(sessionId)
    return this.dependencies.prepareExport?.(sessionId) ?? Promise.resolve()
  }
  private async results(actor: SessionActor, sid: string) {
    const packet = await this.dependencies.results(sid)
    this.requireSession(sid)
    this.pruneArtifacts()
    const orderedRecords = [...(packet?.records ?? [])].sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt),
    )
    const priority = new Map<string, number>()
    for (const record of orderedRecords)
      for (const file of record.files)
        if (file.artifactId && !priority.has(file.artifactId))
          priority.set(file.artifactId, priority.size)
    const orderedArtifacts = [...(packet?.artifacts ?? [])].sort(
      (left, right) => (priority.get(left.id) ?? Infinity) - (priority.get(right.id) ?? Infinity),
    )
    const ids = new Map<string, string>(),
      artifacts: MobileArtifact[] = [],
      emitted = new Set<string>()
    let added = 0
    for (const artifact of orderedArtifacts) {
      if (
        artifact.byteLength > MAX_ARTIFACT_BYTES ||
        artifact.base64.length > Math.ceil((MAX_ARTIFACT_BYTES * 4) / 3)
      )
        continue
      const bytes = Buffer.from(artifact.base64, 'base64')
      if (
        bytes.length !== artifact.byteLength ||
        digest(bytes) !== artifact.sha256 ||
        // eslint-disable-next-line no-control-regex -- Reject control bytes at the filesystem/auth boundary.
        /[\x00-\x1f\x7f\\/]/.test(artifact.name) ||
        artifact.name.length > 240
      )
        continue
      const id = digest(JSON.stringify([artifact.name, artifact.sha256])),
        key = `${actor.deviceId}:${sid}:${id}`
      if (emitted.has(id)) {
        ids.set(artifact.id, id)
        continue
      }
      if (added + bytes.length > MAX_ARTIFACT_BYTES) continue
      ids.set(artifact.id, id)
      emitted.add(id)
      const value = {
        id,
        name: artifact.name,
        mime: mimeFor(artifact.name),
        bytes: bytes.length,
        digest: artifact.sha256,
      }
      this.artifacts.delete(key)
      this.artifacts.set(key, {
        ...value,
        body: bytes,
        expiresAt: this.now() + ARTIFACT_TTL,
        deviceId: actor.deviceId,
        sessionId: sid,
      })
      artifacts.push(value)
      added += bytes.length
    }
    let total = [...this.artifacts.values()].reduce((n, item) => n + item.bytes, 0)
    for (const [key, value] of this.artifacts) {
      if (total <= MAX_CACHE_BYTES) break
      this.artifacts.delete(key)
      total -= value.bytes
    }
    const records = orderedRecords.slice(0, 20).map((record) => ({
      ...record,
      files: record.files.slice(0, 8).map((file) => ({
        ...file,
        artifactId: file.artifactId ? ids.get(file.artifactId) : undefined,
        details: file.details.slice(0, 4).map((detail) => ({
          ...detail,
          before: detail.before?.slice(0, 256),
          after: detail.after?.slice(0, 256),
        })),
      })),
    }))
    return { records, artifacts, truncated: (packet?.records.length ?? 0) > 20 }
  }

  async prepareImport(id: string) {
    await this.dependencies.prepareImport?.(id)
  }
}
