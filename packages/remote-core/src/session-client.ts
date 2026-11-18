import type { SessionCommand, SessionCommandReceipt } from '@genoffice/project-store'

/** A ready, authenticated application channel supplied by the transport owner. This client does not authenticate raw sockets. */
export interface SessionChannel {
  send(message: string): Promise<void>
  onMessage(handler: (message: string) => void): () => void
  onClose(handler: () => void): () => void
  close(): void | Promise<void>
}
export class RemoteSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'RemoteSessionError'
  }
}
interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
const MAX_BYTES = 2 * 1024 * 1024
const invalid = () =>
  new RemoteSessionError('INVALID_MESSAGE', 'The host sent an invalid Session response.')

/** No blind retries. Commands retain their own requestId when the caller deliberately retries on a new channel. */
export class SessionRpcClient {
  private channel?: SessionChannel
  private generation = 0
  private subscriptions: Array<() => void> = []
  private pending = new Map<string, Pending>()
  private closed = false
  constructor(private readonly options: { timeoutMs?: number; newId?: () => string } = {}) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 120_000)
    )
      throw new RangeError('Request timeout must be between 1 and 120000 ms.')
  }
  attach(channel: SessionChannel): void {
    if (this.closed) throw new RemoteSessionError('CLIENT_CLOSED', 'The client is closed.')
    this.drop(new RemoteSessionError('CONNECTION_REPLACED', 'The connection was replaced.'))
    const generation = ++this.generation
    this.channel = channel
    const retain = (off: () => void) => {
      if (generation === this.generation && this.channel === channel) this.subscriptions.push(off)
      else off()
    }
    retain(
      channel.onMessage((message) => {
        if (generation === this.generation && this.channel === channel) this.receive(message)
      }),
    )
    if (this.channel === channel)
      retain(
        channel.onClose(() => {
          if (generation === this.generation && this.channel === channel)
            this.drop(new RemoteSessionError('CONNECTION_LOST', 'The connection was lost.'))
        }),
      )
  }
  call(method: string, params: unknown = {}): Promise<unknown> {
    const channel = this.channel
    const generation = this.generation
    if (!channel || this.closed)
      return Promise.reject(new RemoteSessionError('NOT_CONNECTED', 'Connect to the host first.'))
    if (this.pending.size >= 128)
      return Promise.reject(
        new RemoteSessionError('TOO_MANY_REQUESTS', 'Too many pending requests.'),
      )
    const id = (this.options.newId ?? (() => globalThis.crypto.randomUUID()))()
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || this.pending.has(id))
      return Promise.reject(
        new RemoteSessionError('INVALID_REQUEST_ID', 'A unique request ID is required.'),
      )
    let message: string
    try {
      message = JSON.stringify({ version: 1, id, method, params })
      if (new TextEncoder().encode(message).length > MAX_BYTES)
        throw new RemoteSessionError('FRAME_TOO_LARGE', 'The Session request is too large.')
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new RemoteSessionError(
            'REQUEST_TIMEOUT',
            'The host did not confirm this request. Its outcome may be unknown.',
          ),
        )
      }, this.options.timeoutMs ?? 10_000)
      const pending = { resolve, reject, timer }
      this.pending.set(id, pending)
      void Promise.resolve()
        .then(() => {
          if (
            this.pending.get(id) !== pending ||
            this.channel !== channel ||
            this.generation !== generation
          )
            return
          return channel.send(message)
        })
        .catch((error) => {
          if (this.pending.get(id) !== pending) return
          this.pending.delete(id)
          clearTimeout(timer)
          reject(
            new RemoteSessionError(
              'SEND_FAILED',
              'The request could not be confirmed.',
              error instanceof Error ? error.message : undefined,
            ),
          )
        })
    })
  }
  async command(command: SessionCommand): Promise<SessionCommandReceipt> {
    const value = await this.call('sessions.command', command)
    if (!value || typeof value !== 'object') throw invalid()
    const receipt = value as SessionCommandReceipt
    if (
      receipt.requestId !== command.requestId ||
      typeof receipt.sessionId !== 'string' ||
      !/^[0-9a-f-]{20,64}$/i.test(receipt.sessionId) ||
      typeof receipt.duplicate !== 'boolean' ||
      (command.kind !== 'create' && receipt.sessionId !== command.sessionId) ||
      !Array.isArray(receipt.affectedSessionIds) ||
      receipt.affectedSessionIds.length > 1024 ||
      !receipt.affectedSessionIds.includes(receipt.sessionId) ||
      receipt.affectedSessionIds.some(
        (id) => typeof id !== 'string' || !/^[0-9a-f-]{20,64}$/i.test(id),
      ) ||
      !receipt.version ||
      !Number.isSafeInteger(receipt.version.revision) ||
      receipt.version.revision < 0 ||
      !/^[a-f0-9]{64}$/.test(receipt.version.summaryDigest) ||
      !/^[a-f0-9]{64}$/.test(receipt.version.treeDigest)
    )
      throw invalid()
    return receipt
  }
  close(): void {
    this.closed = true
    this.drop(new RemoteSessionError('CLIENT_CLOSED', 'The client is closed.'))
  }
  private receive(message: string): void {
    try {
      if (typeof message !== 'string' || new TextEncoder().encode(message).length > MAX_BYTES)
        throw invalid()
      const response = JSON.parse(message)
      if (
        !response ||
        response.version !== 1 ||
        typeof response.id !== 'string' ||
        typeof response.ok !== 'boolean'
      )
        throw invalid()
      const allowed = response.ok
        ? ['version', 'id', 'ok', 'value']
        : ['version', 'id', 'ok', 'error']
      if (Object.keys(response).some((key) => !allowed.includes(key))) throw invalid()
      if (
        !response.ok &&
        (!response.error ||
          typeof response.error.code !== 'string' ||
          response.error.code.length > 80 ||
          typeof response.error.message !== 'string')
      )
        throw invalid()
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      clearTimeout(pending.timer)
      if (response.ok) pending.resolve(response.value)
      else
        pending.reject(
          new RemoteSessionError(
            response.error.code,
            response.error.message,
            response.error.currentVersion,
          ),
        )
    } catch {
      this.drop(invalid())
    }
  }
  private drop(error: RemoteSessionError): void {
    this.generation++
    const channel = this.channel
    this.channel = undefined
    for (const off of this.subscriptions.splice(0)) off()
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    if (channel)
      void Promise.resolve()
        .then(() => channel.close())
        .catch(() => {})
  }
}
