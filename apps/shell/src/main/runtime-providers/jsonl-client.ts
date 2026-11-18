import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

type JsonObject = Record<string, unknown>

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface JsonlNotification {
  method: string
  params?: unknown
}

export interface JsonlAppServerOptions {
  executablePath: string
  argsPrefix?: readonly string[]
  configOverrides?: readonly string[]
  experimentalApi?: boolean
  cwd: string
  env: NodeJS.ProcessEnv
  clientVersion: string
  requestTimeoutMs?: number
}

const STDERR_LIMIT = 32 * 1024

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function stringField(value: unknown, key: string): string | undefined {
  const field = asObject(value)?.[key]
  return typeof field === 'string' && field.trim() ? field : undefined
}

function errorMessage(value: unknown): string {
  const object = asObject(value)
  const message = object?.message
  return typeof message === 'string' && message.trim()
    ? message
    : 'Codex App Server request failed.'
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[redacted-api-key]')
    .replace(/([?&](?:access_token|refresh_token|code)=)[^&\s]+/giu, '$1[redacted]')
}

/**
 * Strict JSONL client for the official `codex app-server` process.
 *
 * stdout is protocol-only: this class never scrapes human terminal copy. Logs
 * remain on stderr and are retained only as a small diagnostic tail.
 */
export class JsonlAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Set<(notification: JsonlNotification) => void>()
  private readonly serverHandlers = new Map<string, (params: unknown) => Promise<unknown>>()
  private readonly serverRequests = new Set<string | number>()
  private readonly requestTimeoutMs: number
  private nextId = 1
  private stderrTailValue = ''
  private closedValue = false
  private closePromise: Promise<void> | null = null

  private constructor(child: ChildProcessWithoutNullStreams, requestTimeoutMs: number) {
    this.child = child
    this.requestTimeoutMs = requestTimeoutMs
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTailValue = redactDiagnostic(`${this.stderrTailValue}${chunk}`).slice(
        -STDERR_LIMIT,
      )
    })

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.handleLine(line))
    child.once('error', (error) => this.failAll(error))
    child.once('exit', (code, signal) => {
      const detail = this.stderrTailValue.trim()
      const suffix = detail ? ` ${detail.slice(-2_000)}` : ''
      this.failAll(
        new Error(
          `Codex App Server exited${code === null ? '' : ` with code ${code}`}${
            signal ? ` (${signal})` : ''
          }.${suffix}`,
        ),
      )
    })
  }

  static async start(options: JsonlAppServerOptions): Promise<JsonlAppServerClient> {
    const args = [
      ...(options.argsPrefix ?? []),
      'app-server',
      ...(options.configOverrides ?? []).flatMap((value) => ['--config', value]),
    ]
    const child = spawn(options.executablePath, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = new JsonlAppServerClient(child, options.requestTimeoutMs ?? 30_000)
    try {
      await client.request('initialize', {
        clientInfo: {
          name: 'bigdog-office',
          title: 'BigDog Office',
          version: options.clientVersion,
        },
        ...(options.experimentalApi ? { capabilities: { experimentalApi: true } } : {}),
      })
      client.notify('initialized')
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  get closed(): boolean {
    return this.closedValue
  }

  get stderrTail(): string {
    return this.stderrTailValue
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.closedValue) return Promise.reject(new Error('Codex App Server is not running.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex App Server request timed out: ${method}.`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      try {
        this.write({ id, method, params: params === undefined ? {} : params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params: params ?? {} })
  }

  subscribe(listener: (notification: JsonlNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Only explicitly registered official server methods may execute client tools. */
  handleRequest(method: string, handler: (params: unknown) => Promise<unknown>): () => void {
    if (this.serverHandlers.has(method))
      throw new Error(`Server request handler already registered: ${method}`)
    this.serverHandlers.set(method, handler)
    return () => {
      if (this.serverHandlers.get(method) === handler) this.serverHandlers.delete(method)
    }
  }

  waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean = () => true,
    timeoutMs = 5 * 60_000,
  ): Promise<unknown> {
    if (this.closedValue) return Promise.reject(new Error('Codex App Server is not running.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timed out waiting for Codex notification: ${method}.`))
      }, timeoutMs)
      const unsubscribe = this.subscribe((notification) => {
        if (notification.method === '$transport/closed') {
          clearTimeout(timer)
          unsubscribe()
          reject(
            new Error(stringField(notification.params, 'message') ?? 'Codex App Server closed.'),
          )
          return
        }
        if (notification.method !== method || !predicate(notification.params)) return
        clearTimeout(timer)
        unsubscribe()
        resolve(notification.params)
      })
    })
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.closeProcess()
    return this.closePromise
  }

  private write(message: JsonObject): void {
    if (this.closedValue || !this.child.stdin.writable) {
      throw new Error('Codex App Server is not writable.')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.failAll(new Error('Codex App Server emitted non-JSON stdout.'))
      void this.close()
      return
    }
    const message = asObject(parsed)
    if (!message) return
    if (
      (typeof message.id === 'number' || typeof message.id === 'string') &&
      typeof message.method === 'string'
    ) {
      const id = message.id
      if (this.serverRequests.has(id)) {
        this.failAll(new Error('Codex sent a duplicate in-flight server request id.'))
        void this.close()
        return
      }
      const handler = this.serverHandlers.get(message.method)
      if (!handler) {
        this.write({
          id,
          error: { code: -32601, message: `Unsupported server request: ${message.method}` },
        })
        return
      }
      this.serverRequests.add(id)
      void Promise.resolve()
        .then(() => handler(message.params))
        .then(
          (result) => {
            if (!this.closedValue) this.write({ id, result })
          },
          (error: unknown) => {
            if (!this.closedValue)
              this.write({
                id,
                error: {
                  code: -32602,
                  message: redactDiagnostic(error instanceof Error ? error.message : String(error)),
                },
              })
          },
        )
        .catch((error: Error) => {
          this.failAll(error)
          void this.close()
        })
        .finally(() => this.serverRequests.delete(id))
      return
    }
    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if ('error' in message && message.error != null)
        request.reject(new Error(errorMessage(message.error)))
      else request.resolve(message.result)
      return
    }
    if (typeof message.method === 'string') {
      const notification = { method: message.method, params: message.params }
      for (const listener of [...this.listeners]) listener(notification)
    }
  }

  private failAll(error: Error): void {
    const unexpected = !this.closedValue
    this.closedValue = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    this.serverHandlers.clear()
    this.serverRequests.clear()
    if (unexpected) {
      const notification = {
        method: '$transport/closed',
        params: { message: redactDiagnostic(error.message) },
      }
      for (const listener of [...this.listeners]) listener(notification)
    }
  }

  private async closeProcess(): Promise<void> {
    this.failAll(new Error('Codex App Server closed.'))
    this.child.stdin.end()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
    this.child.kill('SIGTERM')
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ])
    if (graceful) return
    const pid = this.child.pid
    if (process.platform === 'win32' && typeof pid === 'number' && Number.isSafeInteger(pid)) {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      await Promise.race([
        new Promise<void>((resolve) => killer.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ])
    } else {
      this.child.kill('SIGKILL')
    }
  }
}
