import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  OFFICE_RUNTIME_CAPABILITIES,
  type ModelEvent,
  type ProviderStatus,
  type RuntimeProvider,
  type RuntimeGenerateOptions,
} from '../../shared/runtime-provider-api'
import {
  CodexRuntimeInstaller,
  type RuntimeInstallation,
  type RuntimeInstaller,
} from './codex-installer'
import { JsonlAppServerClient } from './jsonl-client'
import { codexDynamicTools } from './codex-tools'
import {
  CODEX_TEXT_PERMISSION_PROFILE,
  codexPermissionOverrides,
  codexThreadParams,
  codexTurnParams,
  requireCodexPermissionProfile,
} from './codex-permissions'

type JsonObject = Record<string, unknown>

interface CodexRuntimeProviderOptions {
  root: string
  appVersion: string
  openExternal(url: string): Promise<unknown>
  installer?: RuntimeInstaller
  generateTimeoutMs?: number
  platform?: NodeJS.Platform
}

interface ActiveGeneration {
  client: JsonlAppServerClient
  threadId: string
  turnId: string | null
  cancelled: boolean
  finish(event: ModelEvent): void
}

class ModelEventQueue implements AsyncIterable<ModelEvent> {
  private readonly queued: ModelEvent[] = []
  private readonly waiting: Array<(value: IteratorResult<ModelEvent>) => void> = []
  private ended = false

  push(event: ModelEvent): void {
    if (this.ended) return
    const resolve = this.waiting.shift()
    if (resolve) resolve({ done: false, value: event })
    else this.queued.push(event)
  }

  end(finalEvent: ModelEvent): void {
    if (this.ended) return
    this.push(finalEvent)
    this.ended = true
    while (this.waiting.length && !this.queued.length) {
      this.waiting.shift()?.({ done: true, value: undefined })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
    return {
      next: () => {
        const value = this.queued.shift()
        if (value) return Promise.resolve({ done: false, value })
        if (this.ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.waiting.push(resolve))
      },
    }
  }
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function stringField(value: unknown, key: string): string | undefined {
  const field = asObject(value)?.[key]
  return typeof field === 'string' && field.trim() ? field : undefined
}

function nestedString(value: unknown, objectKey: string, fieldKey: string): string | undefined {
  return stringField(asObject(value)?.[objectKey], fieldKey)
}

function safeAuthUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Codex did not return an OAuth URL.')
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  const allowed =
    host === 'openai.com' ||
    host.endsWith('.openai.com') ||
    host === 'chatgpt.com' ||
    host.endsWith('.chatgpt.com')
  if (url.protocol !== 'https:' || !allowed) {
    throw new Error('Codex returned an unexpected OAuth origin.')
  }
  return url.toString()
}

function privateCodexEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // This provider is deliberately ChatGPT-account-only. Do not let ambient
  // developer API credentials silently change the official runtime auth path.
  const removed = new Set([
    'CODEX_HOME',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT_ID',
  ])
  for (const key of Object.keys(env)) {
    if (removed.has(key.toUpperCase())) delete env[key]
  }
  env.CODEX_HOME = join(root, 'home')
  return env
}

function accountFrom(value: unknown): JsonObject | null {
  const object = asObject(value)
  return asObject(object?.account)
}

export class CodexRuntimeProvider implements RuntimeProvider {
  readonly id = 'codex' as const
  readonly capabilities = OFFICE_RUNTIME_CAPABILITIES
  private readonly root: string
  private readonly workDir: string
  private readonly installer: RuntimeInstaller
  private readonly appVersion: string
  private readonly openExternal: (url: string) => Promise<unknown>
  private readonly generateTimeoutMs: number
  private readonly platform: NodeJS.Platform
  private client: JsonlAppServerClient | null = null
  private clientStarting: Promise<JsonlAppServerClient> | null = null
  private clientRuntimePath: string | null = null
  private active: ActiveGeneration | null = null
  private generating = false
  private cancelRequested = false
  private disposed = false
  private installing = false
  private phaseOverride: ProviderStatus['phase'] | null = null
  private lastError: string | undefined

  constructor(options: CodexRuntimeProviderOptions) {
    this.root = options.root
    this.workDir = join(this.root, 'work')
    this.installer = options.installer ?? new CodexRuntimeInstaller(this.root)
    this.appVersion = options.appVersion
    this.openExternal = options.openExternal
    this.generateTimeoutMs = options.generateTimeoutMs ?? 5 * 60_000
    this.platform = options.platform ?? process.platform
  }

  detect(): Promise<boolean> {
    return this.installer.detect()
  }

  fork(): CodexRuntimeProvider {
    if (this.disposed || this.installing) throw new Error('ChatGPT is temporarily unavailable.')
    return new CodexRuntimeProvider({
      root: this.root,
      appVersion: this.appVersion,
      openExternal: this.openExternal,
      installer: this.installer,
      generateTimeoutMs: this.generateTimeoutMs,
      platform: this.platform,
    })
  }

  async install(): Promise<void> {
    if (this.installing) throw new Error('Codex Runtime installation is already in progress.')
    this.installing = true
    this.phaseOverride = 'installing'
    this.lastError = undefined
    try {
      // Windows cannot replace/remove a running executable. Stop the private
      // App Server before the installer rotates version directories.
      await this.cancel()
      await this.closeClient()
      await this.installer.install()
      this.phaseOverride = null
    } catch (error) {
      this.fail(error)
      await this.closeClient()
      throw error
    } finally {
      this.installing = false
    }
  }

  async login(): Promise<void> {
    this.phaseOverride = 'authenticating'
    this.lastError = undefined
    let completion: Promise<unknown> | null = null
    try {
      if (!(await this.installer.detect())) await this.install()
      this.phaseOverride = 'authenticating'
      const client = await this.ensureClient()
      // Only the explicit Connect action may trigger official Windows setup/UAC.
      await this.prepareWindowsSandbox(client)
      const existingAccount = accountFrom(
        await client.request('account/read', { refreshToken: false }),
      )
      if (stringField(existingAccount, 'type') === 'chatgpt') {
        this.phaseOverride = null
        return
      }
      const started = await client.request('account/login/start', {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt',
      })
      const loginId = stringField(started, 'loginId')
      if (!loginId) throw new Error('Codex did not return an OAuth login id.')
      const authUrl = safeAuthUrl(stringField(started, 'authUrl'))
      completion = client.waitForNotification(
        'account/login/completed',
        (params) => stringField(params, 'loginId') === loginId,
        10 * 60_000,
      )
      await this.openExternal(authUrl)
      const result = await completion
      if (asObject(result)?.success !== true) {
        throw new Error(stringField(result, 'error') ?? 'ChatGPT sign-in did not complete.')
      }
      this.phaseOverride = null
      const status = await this.status()
      if (!status.ready) throw new Error('Codex signed in without a ChatGPT subscription account.')
    } catch (error) {
      void completion?.catch(() => {})
      this.fail(error)
      await this.closeClient()
      throw error
    }
  }

  async status(): Promise<ProviderStatus> {
    const installation = await this.installer.current()
    if (!installation) {
      return {
        id: this.id,
        label: 'ChatGPT / Codex',
        phase: this.phaseOverride ?? 'not-installed',
        installed: false,
        authenticated: false,
        ready: false,
        capabilities: this.capabilities,
        error: this.lastError,
      }
    }
    if (
      this.phaseOverride === 'installing' ||
      this.phaseOverride === 'authenticating' ||
      this.phaseOverride === 'preparing'
    ) {
      return {
        id: this.id,
        label: 'ChatGPT / Codex',
        phase: this.phaseOverride,
        installed: true,
        authenticated: false,
        ready: false,
        capabilities: this.capabilities,
        version: installation.version,
      }
    }
    try {
      const accountResult = await (
        await this.ensureClient(installation)
      ).request('account/read', {
        refreshToken: false,
      })
      const account = accountFrom(accountResult)
      const accountType = stringField(account, 'type')
      const authenticated = accountType === 'chatgpt'
      const sandboxReady =
        !authenticated ||
        this.platform !== 'win32' ||
        (await this.windowsSandboxReady(await this.ensureClient(installation)))
      this.lastError = undefined
      this.phaseOverride = null
      return {
        id: this.id,
        label: 'ChatGPT / Codex',
        phase: authenticated ? (sandboxReady ? 'ready' : 'error') : 'signed-out',
        installed: true,
        authenticated,
        ready: authenticated && sandboxReady,
        capabilities: this.capabilities,
        version: installation.version,
        accountLabel: stringField(account, 'email'),
        plan: stringField(account, 'planType') ?? stringField(account, 'plan'),
        ...(!sandboxReady
          ? {
              error:
                'Windows sandbox setup is required for restricted reads. Click Connect account and allow the official Codex sandbox setup.',
            }
          : {}),
      }
    } catch (error) {
      this.fail(error)
      await this.closeClient()
      return {
        id: this.id,
        label: 'ChatGPT / Codex',
        phase: 'error',
        installed: true,
        authenticated: false,
        ready: false,
        capabilities: this.capabilities,
        version: installation.version,
        error: this.lastError,
      }
    }
  }

  generate(prompt: string, options?: RuntimeGenerateOptions): AsyncIterable<ModelEvent> {
    if (this.disposed) throw new Error('Codex Runtime Provider is shutting down.')
    if (this.generating) throw new Error('Codex Runtime is already generating.')
    this.generating = true
    this.cancelRequested = false
    const queue = new ModelEventQueue()
    queue.push({ type: 'status', status: 'starting' })
    void this.startGeneration(prompt, queue, options)
    return queue
  }

  async cancel(): Promise<void> {
    const active = this.active
    if (!this.generating) return
    this.cancelRequested = true
    if (!active || active.cancelled) return
    active.cancelled = true
    if (active.turnId) {
      await active.client
        .request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 5_000)
        .catch(() => {})
    }
    setTimeout(() => {
      if (this.active !== active) return
      void this.closeClient()
      active.finish({ type: 'done', stopReason: 'cancelled' })
    }, 2_000)
  }

  async logout(): Promise<void> {
    await this.cancel()
    const installation = await this.installer.current()
    if (!installation) return
    await (await this.ensureClient(installation)).request('account/logout', {})
    this.phaseOverride = null
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.cancel()
    await this.closeClient()
  }

  private async startGeneration(
    prompt: string,
    queue: ModelEventQueue,
    options?: RuntimeGenerateOptions,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = () => {}
    let unregisterTools = () => {}
    try {
      const status = await this.status()
      if (!status.ready)
        throw new Error(status.error ?? 'Connect a ChatGPT account before using Codex Runtime.')
      const client = await this.ensureClient()
      if (this.cancelRequested) {
        this.generating = false
        this.cancelRequested = false
        queue.end({ type: 'done', stopReason: 'cancelled' })
        return
      }
      await mkdir(this.workDir, { recursive: true })
      const tools = codexDynamicTools(options?.tools ?? [])
      const thread = await client.request('thread/start', {
        ...codexThreadParams(this.workDir),
        ...(tools.definitions.length ? { dynamicTools: tools.definitions } : {}),
      })
      if (
        nestedString(thread, 'activePermissionProfile', 'id') !== CODEX_TEXT_PERMISSION_PROFILE ||
        asObject(thread)?.approvalPolicy !== 'never'
      ) {
        await this.closeClient()
        throw new Error(
          'Codex did not activate the required read-restricted permission profile. Generation was blocked.',
        )
      }
      const threadId = nestedString(thread, 'thread', 'id') ?? stringField(thread, 'threadId')
      if (!threadId) throw new Error('Codex did not create a thread.')
      let settled = false
      const finish = (event: ModelEvent) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        unsubscribe()
        unregisterTools()
        if (this.active?.threadId === threadId) this.active = null
        this.generating = false
        this.cancelRequested = false
        queue.end(event)
      }
      const active: ActiveGeneration = {
        client,
        threadId,
        turnId: null,
        cancelled: this.cancelRequested,
        finish,
      }
      this.active = active
      const calls = new Map<string, { signature: string; result: Promise<unknown> }>()
      unregisterTools = client.handleRequest('item/tool/call', async (raw) => {
        const params = asObject(raw)
        const callId = stringField(params, 'callId')
        const turnId = stringField(params, 'turnId')
        const wireName = stringField(params, 'tool')
        const name = wireName ? tools.aliases.get(wireName) : undefined
        const input = asObject(params?.arguments)
        const failure = (text: string) => ({
          contentItems: [{ type: 'inputText', text }],
          success: false,
        })
        if (settled || active.cancelled || this.cancelRequested)
          return failure('Run stopped; this tool was not executed.')
        if (
          stringField(params, 'threadId') !== threadId ||
          !turnId ||
          (active.turnId && active.turnId !== turnId)
        ) {
          throw new Error('Office tool request does not belong to the active Runtime turn.')
        }
        // The server may request a tool before acknowledging turn/start.
        active.turnId ??= turnId
        if (!callId || !name || !input || params?.namespace != null || !options) {
          throw new Error('Invalid or undeclared Codex Office tool request.')
        }
        const signature = JSON.stringify([name, input])
        const previous = calls.get(callId)
        if (previous) {
          if (previous.signature !== signature)
            throw new Error('Codex reused a tool call id with different arguments.')
          return previous.result // retries must never execute a mutation twice
        }
        if (calls.size >= 256)
          return failure(
            'Runtime tool request limit reached. Stop calling tools and summarize the actual results.',
          )
        const result = Promise.resolve()
          .then(async () => {
            if (settled || active.cancelled) return failure('Run stopped; not executed.')
            const execution = await options.executeTool({ id: callId, name, input })
            return {
              contentItems: [{ type: 'inputText', text: execution.output }],
              success: !execution.isError,
            }
          })
          .catch((error: unknown) =>
            failure(error instanceof Error ? error.message : String(error)),
          )
        calls.set(callId, { signature, result })
        return result
      })
      unsubscribe = client.subscribe((notification) => {
        const params = asObject(notification.params)
        if (notification.method === '$transport/closed') {
          finish(
            active.cancelled
              ? { type: 'done', stopReason: 'cancelled' }
              : {
                  type: 'error',
                  error: stringField(params, 'message') ?? 'Codex Runtime crashed.',
                },
          )
          return
        }
        if (notification.method === 'item/agentMessage/delta') {
          const eventThreadId = stringField(params, 'threadId')
          const eventTurnId = stringField(params, 'turnId')
          if (eventThreadId && eventThreadId !== threadId) return
          if (active.turnId && eventTurnId && eventTurnId !== active.turnId) return
          if (active.cancelled) return
          const delta = stringField(params, 'delta')
          if (delta) {
            queue.push({ type: 'status', status: 'streaming' })
            queue.push({ type: 'text-delta', text: delta })
          }
          return
        }
        if (notification.method === 'turn/completed') {
          const turn = asObject(params?.turn)
          const eventThreadId = stringField(params, 'threadId') ?? stringField(turn, 'threadId')
          const eventTurnId = stringField(turn, 'id') ?? stringField(params, 'turnId')
          if (eventThreadId && eventThreadId !== threadId) return
          if (active.turnId && eventTurnId && eventTurnId !== active.turnId) return
          const statusValue = stringField(turn, 'status') ?? stringField(params, 'status')
          if (statusValue === 'failed') {
            finish({
              type: 'error',
              error: nestedString(turn, 'error', 'message') ?? 'Codex Runtime turn failed.',
            })
          } else {
            finish({ type: 'done', stopReason: active.cancelled ? 'cancelled' : statusValue })
          }
          return
        }
        if (notification.method === 'error') {
          const eventThreadId = stringField(params, 'threadId')
          if (eventThreadId && eventThreadId !== threadId) return
          finish({
            type: 'error',
            error:
              nestedString(params, 'error', 'message') ??
              stringField(params, 'message') ??
              'Codex Runtime failed.',
          })
        }
      })
      const turn = await client.request(
        'turn/start',
        codexTurnParams(threadId, prompt, this.workDir),
      )
      if (settled) return
      active.turnId = nestedString(turn, 'turn', 'id') ?? stringField(turn, 'turnId') ?? null
      if (!active.turnId) throw new Error('Codex did not create a turn.')
      if (active.cancelled) {
        await client
          .request('turn/interrupt', { threadId, turnId: active.turnId }, 5_000)
          .catch(() => {})
      }
      timer = setTimeout(() => {
        if (this.active !== active) return
        active.cancelled = true
        void client
          .request('turn/interrupt', { threadId, turnId: active.turnId }, 5_000)
          .catch(() => {})
        finish({ type: 'error', error: 'Codex Runtime generation timed out.' })
        void this.closeClient()
      }, this.generateTimeoutMs)
    } catch (error) {
      unsubscribe()
      unregisterTools()
      if (timer) clearTimeout(timer)
      this.active = null
      this.generating = false
      this.cancelRequested = false
      queue.end({ type: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async ensureClient(installation?: RuntimeInstallation): Promise<JsonlAppServerClient> {
    if (this.disposed) throw new Error('Codex Runtime Provider is shutting down.')
    if (this.installing) throw new Error('Codex Runtime is being installed or upgraded.')
    const current = installation ?? (await this.installer.current())
    if (!current) throw new Error('Codex Runtime is not installed.')
    if (this.clientStarting) return this.clientStarting
    if (this.client && !this.client.closed && this.clientRuntimePath === current.executablePath) {
      return this.client
    }
    const starting = this.startClient(current)
    this.clientStarting = starting
    try {
      return await starting
    } finally {
      if (this.clientStarting === starting) this.clientStarting = null
    }
  }

  private async startClient(current: RuntimeInstallation): Promise<JsonlAppServerClient> {
    const previous = this.client
    this.client = null
    this.clientRuntimePath = null
    await previous?.close()
    await Promise.all([
      mkdir(this.workDir, { recursive: true }),
      mkdir(join(this.root, 'home'), { recursive: true }),
    ])
    const client = await JsonlAppServerClient.start({
      executablePath: current.executablePath,
      argsPrefix: current.argsPrefix,
      cwd: this.workDir,
      env: privateCodexEnvironment(this.root),
      clientVersion: this.appVersion,
      configOverrides: codexPermissionOverrides(this.workDir, this.platform),
      experimentalApi: true,
    })
    try {
      await requireCodexPermissionProfile(client, this.workDir)
      this.client = client
      this.clientRuntimePath = current.executablePath
      return client
    } catch (error) {
      await client.close()
      throw new Error(
        `Codex Runtime permission protocol is incompatible: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  private async windowsSandboxReady(client: JsonlAppServerClient): Promise<boolean> {
    return stringField(await client.request('windowsSandbox/readiness', null), 'status') === 'ready'
  }

  private async prepareWindowsSandbox(client: JsonlAppServerClient): Promise<void> {
    if (this.platform !== 'win32' || (await this.windowsSandboxReady(client))) return
    this.phaseOverride = 'preparing'
    // Subscribe first: a fast setup may finish before setupStart responds.
    const completion = client.waitForNotification(
      'windowsSandbox/setupCompleted',
      (params) => stringField(params, 'mode') === 'elevated',
      10 * 60_000,
    )
    void completion.catch(() => {})
    try {
      const started = await client.request('windowsSandbox/setupStart', {
        mode: 'elevated',
        cwd: this.workDir,
      })
      if (asObject(started)?.started !== true)
        throw new Error('Official Windows sandbox setup did not start.')
      const result = await completion
      if (asObject(result)?.success !== true || !(await this.windowsSandboxReady(client))) {
        throw new Error(
          stringField(result, 'error') ?? 'Official Windows sandbox setup did not complete.',
        )
      }
      this.phaseOverride = 'authenticating'
    } catch (error) {
      throw new Error(
        `Windows sandbox setup failed; restricted reads remain enforced. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  private async closeClient(): Promise<void> {
    await this.clientStarting?.catch(() => {})
    const client = this.client
    this.client = null
    this.clientRuntimePath = null
    await client?.close().catch(() => {})
  }

  private fail(error: unknown): void {
    this.phaseOverride = 'error'
    this.lastError = error instanceof Error ? error.message : String(error)
  }
}
