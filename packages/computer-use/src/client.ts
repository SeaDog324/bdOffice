import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  CUA_SDK_VERSION,
  MAX_IMAGE_BYTES,
  isRecord,
  type DriverPort,
  type DriverResult,
  type DriverStatus,
  type WorkerResponse,
} from './protocol'

export class IsolatedCuaClient implements DriverPort {
  private child: ChildProcess | undefined
  private retiring = new Set<ChildProcess>()
  private pending: { id: string; reject(error: Error): void } | undefined
  constructor(
    private readonly options: {
      workerPath: string
      executable?: string
      sdkEntry?: string
      timeoutMs?: number
      fork?: typeof fork
    },
  ) {}
  private ensureChild(): ChildProcess {
    if (this.retiring.size) throw new Error('computer_driver_stopping')
    if (this.child?.connected) return this.child
    if (this.child) {
      this.failChild(this.child)
      if (this.retiring.size) throw new Error('computer_driver_stopping')
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    delete env.BIGDOG_CUA_SDK_ENTRY
    if (this.options.sdkEntry) env.BIGDOG_CUA_SDK_ENTRY = this.options.sdkEntry
    for (const key of Object.keys(env))
      if (/API_KEY|TOKEN|SECRET|PASSWORD|^BIGDOG_REMOTE/i.test(key)) delete env[key]
    const childOptions: ForkOptions & { windowsHide: boolean } = {
      execPath: this.options.executable ?? process.execPath,
      env,
      execArgv: [],
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }
    const child = (this.options.fork ?? fork)(this.options.workerPath, [], childOptions)
    // Drain native diagnostics, without retaining captured text or credentials.
    child.stderr?.resume()
    this.child = child
    const lost = () => {
      if (this.child !== child) return
      this.child = undefined
      this.pending?.reject(new Error('computer_driver_exited'))
    }
    child.once('error', () => this.failChild(child))
    child.once('disconnect', () => this.failChild(child))
    child.once('exit', lost)
    return child
  }
  /** IPC loss does not prove that native input stopped. Fence the old process until exit. */
  private failChild(child: ChildProcess): void {
    if (this.child !== child) return
    this.retire(child)
    this.pending?.reject(new Error('computer_driver_exited'))
    if (child.exitCode === null) child.kill()
  }
  private retire(child: ChildProcess): void {
    if (this.child === child) this.child = undefined
    if (child.exitCode !== null || this.retiring.has(child)) return
    this.retiring.add(child)
    child.once('exit', () => this.retiring.delete(child))
  }
  private request(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('computer_cancelled'))
    if (this.pending) return Promise.reject(new Error('computer_driver_busy'))
    const child = this.ensureChild(),
      id = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false,
        abortTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(abortTimer)
        signal?.removeEventListener('abort', abort)
        child.removeListener('message', receive)
        if (this.pending?.id === id) this.pending = undefined
        if (error) reject(error)
        else resolve(value)
      }
      const abort = () => {
        if (child.connected)
          child.send({ id: randomUUID(), method: 'cancel', requestId: id }, (error) => {
            if (error) this.failChild(child)
          })
        if (settled) return
        abortTimer = setTimeout(() => {
          this.retire(child)
          child.kill()
          finish(new Error('computer_cancelled_effect_unknown'))
        }, 2000)
      }
      const timer = setTimeout(() => {
        this.retire(child)
        child.kill()
        finish(new Error('computer_timeout_effect_unknown'))
      }, this.options.timeoutMs ?? 25_000)
      const receive = (raw: unknown) => {
        if (!isRecord(raw) || raw.id !== id) return
        const response = raw as unknown as WorkerResponse
        if (signal?.aborted) return finish(new Error('computer_cancelled_effect_unknown'))
        if (typeof response.error === 'string')
          return finish(new Error(response.error.slice(0, 120)))
        if (JSON.stringify(response.result)?.length > MAX_IMAGE_BYTES * 2)
          return finish(new Error('computer_response_too_large'))
        finish(undefined, response.result)
      }
      this.pending = { id, reject: (error) => finish(error) }
      child.on('message', receive)
      signal?.addEventListener('abort', abort, { once: true })
      child.send({ id, method, ...params }, (error) => {
        if (error) this.failChild(child)
      })
    })
  }
  async status(): Promise<DriverStatus> {
    if (this.pending)
      return {
        available: true,
        version: CUA_SDK_VERSION,
        platform: process.platform,
        state: 'busy',
      }
    try {
      return (await this.request('status')) as DriverStatus
    } catch (error) {
      return {
        available: false,
        version: CUA_SDK_VERSION,
        platform: process.platform,
        state: 'error',
        error: error instanceof Error ? error.message : 'computer_driver_failed',
      }
    }
  }
  async call(
    tool: string,
    args: Record<string, unknown>,
    session: string,
    signal?: AbortSignal,
  ): Promise<DriverResult> {
    return (await this.request('call', { tool, args, session }, signal)) as DriverResult
  }
  async endSession(session: string): Promise<void> {
    if (this.child?.connected && !this.pending) await this.request('end', { session })
  }
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.retire(child)
    this.pending?.reject(new Error('computer_stopped_effect_unknown'))
    if (child.connected) child.disconnect()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 2500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      if (child.exitCode !== null) {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}
