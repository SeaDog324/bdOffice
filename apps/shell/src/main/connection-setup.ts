import { createHash, randomUUID } from 'node:crypto'
import {
  AI_PROVIDERS,
  activeProvider,
  chatForProvider,
  defaultAiSettings,
  resolveAiSettings,
  type AiSettings,
} from '@genoffice/ai-provider'
import type { AgentRuntimeSelection } from '../shared/runtime-provider-api'
import type {
  ConnectionCommitResult,
  ConnectionDraft,
  ConnectionSetupError,
  ConnectionSummary,
  ConnectionTestResult,
} from '../shared/connection-setup-api'

const VERIFICATION_TTL_MS = 5 * 60_000
const TEST_TIMEOUT_MS = 30_000
interface SetupDeps {
  readSettings(): AiSettings
  selection(): AgentRuntimeSelection
  accountReady(): Promise<boolean>
  saveSettings(settings: AiSettings): void
  probe?: typeof chatForProvider
  now?: () => number
}
interface Verification {
  owner: number
  requestId: string
  revision: string
  expiresAt: number
  settings?: AiSettings
  committed?: ConnectionSummary
}

/** Keys remain in expiring process memory until the existing settings writer commits them. */
export class ConnectionSetupService {
  private readonly verifications = new Map<string, Verification>()
  private readonly probes = new Map<number, { requestId: string; controller: AbortController }>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private readonly deps: SetupDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)()
  }
  private current() {
    const settings = resolveAiSettings(this.deps.readSettings(), defaultAiSettings())
    const selection = this.deps.selection()
    const revision = createHash('sha256')
      .update(JSON.stringify({ settings, selection }))
      .digest('hex')
    return { settings, selection, revision }
  }
  private summary(
    current: ReturnType<ConnectionSetupService['current']>,
    accountReady = false,
  ): ConnectionSummary {
    const providerId = activeProvider(current.settings)
    const config = current.settings.providers[providerId]
    const usable =
      current.selection === 'api'
        ? !!config.model && (!!config.apiKey || (providerId === 'custom' && !!config.baseUrl))
        : accountReady
    return {
      revision: current.revision,
      selection: current.selection,
      providerId,
      modelId: config.model,
      usable,
      status:
        current.selection !== 'api'
          ? usable
            ? 'ready'
            : 'unavailable'
          : usable
            ? 'configured'
            : 'unconfigured',
    }
  }
  async inspect(): Promise<ConnectionSummary> {
    const current = this.current()
    const ready =
      current.selection === 'api' ? false : await this.deps.accountReady().catch(() => false)
    const latest = this.current()
    return this.summary(latest, latest.revision === current.revision && ready)
  }
  private forget(id: string) {
    this.verifications.delete(id)
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
  }
  cancel(owner: number, requestId: string): void {
    const running = this.probes.get(owner)
    if (running?.requestId === requestId) {
      running.controller.abort()
      this.probes.delete(owner)
    }
    for (const [id, verification] of this.verifications) {
      if (verification.owner === owner && verification.requestId === requestId) this.forget(id)
    }
  }
  release(owner: number): void {
    this.probes.get(owner)?.controller.abort()
    this.probes.delete(owner)
    for (const [id, verification] of this.verifications)
      if (verification.owner === owner) this.forget(id)
  }
  async test(owner: number, input: unknown): Promise<ConnectionTestResult> {
    const fail = (errorCode: ConnectionSetupError): ConnectionTestResult => ({
      ok: false,
      errorCode,
    })
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_input')
    const v = input as Partial<ConnectionDraft>
    const text = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max
    const meta = AI_PROVIDERS.find((p) => p.id === v.providerId)
    if (
      !meta ||
      !text(v.requestId, 128) ||
      !v.requestId ||
      !text(v.expectedRevision, 128) ||
      !text(v.apiKey, 16_384) ||
      /[\r\n]/.test(v.apiKey) ||
      (v.modelId !== undefined && !text(v.modelId, 256)) ||
      (v.baseUrl !== undefined && !text(v.baseUrl, 2048))
    )
      return fail('invalid_input')
    const current = this.current()
    if (current.revision !== v.expectedRevision) return fail('settings_changed')
    if (current.selection !== 'api') return fail('account_selected')
    const baseUrl = v.baseUrl?.trim() || undefined
    if (baseUrl) {
      try {
        const url = new URL(baseUrl)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          return fail('invalid_input')
      } catch {
        return fail('invalid_input')
      }
    }
    if ((!v.apiKey.trim() && !(meta.id === 'custom' && baseUrl)) || (meta.needsBaseUrl && !baseUrl))
      return fail('invalid_input')
    const settings = resolveAiSettings(
      {
        ...current.settings,
        provider: meta.id,
        providers: {
          ...current.settings.providers,
          [meta.id]: {
            ...current.settings.providers[meta.id],
            apiKey: v.apiKey.trim(),
            model: v.modelId?.trim() || meta.defaultModel,
            baseUrl,
            modelCatalog: undefined,
          },
        },
      },
      defaultAiSettings(),
    )
    const config = settings.providers[meta.id]
    if (!config.model) return fail('invalid_input')
    this.release(owner)
    const controller = new AbortController()
    this.probes.set(owner, { requestId: v.requestId, controller })
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    timeout.unref?.()
    try {
      const result = await (this.deps.probe ?? chatForProvider)(
        meta.id,
        config,
        'You are a connectivity test. Reply with the single word OK.',
        'ping',
        controller.signal,
      )
      if (controller.signal.aborted) return fail('test_cancelled')
      if (!result.ok) return fail('test_failed')
      if (this.current().revision !== current.revision) return fail('settings_changed')
      const verificationId = randomUUID(),
        expiresAt = this.now() + VERIFICATION_TTL_MS
      this.verifications.set(verificationId, {
        owner,
        requestId: v.requestId,
        revision: current.revision,
        expiresAt,
        settings,
      })
      const timer = setTimeout(() => this.forget(verificationId), VERIFICATION_TTL_MS)
      timer.unref?.()
      this.timers.set(verificationId, timer)
      return { ok: true, verificationId, expiresAt }
    } catch {
      // Provider errors can echo headers, keys or response bodies. Never return them through this API.
      return fail(controller.signal.aborted ? 'test_cancelled' : 'test_failed')
    } finally {
      clearTimeout(timeout)
      if (this.probes.get(owner)?.controller === controller) this.probes.delete(owner)
    }
  }
  commit(owner: number, input: unknown): ConnectionCommitResult {
    const fail = (errorCode: ConnectionSetupError): ConnectionCommitResult => ({
      ok: false,
      errorCode,
    })
    if (!input || typeof input !== 'object') return fail('invalid_input')
    const v = input as { verificationId?: unknown; expectedRevision?: unknown }
    if (typeof v.verificationId !== 'string' || typeof v.expectedRevision !== 'string')
      return fail('invalid_input')
    const verification = this.verifications.get(v.verificationId)
    if (!verification || verification.owner !== owner || verification.expiresAt <= this.now()) {
      if (verification?.owner === owner) this.forget(v.verificationId)
      return fail('verification_expired')
    }
    if (v.expectedRevision !== verification.revision) return fail('settings_changed')
    if (verification.committed) return { ok: true, connection: verification.committed }
    if (this.current().revision !== verification.revision) {
      this.forget(v.verificationId)
      return fail('settings_changed')
    }
    try {
      // Synchronous compare-and-write: no IPC/model await can interleave a settings change.
      this.deps.saveSettings(verification.settings!)
      verification.settings = undefined
      const connection = this.summary(this.current())
      verification.committed = connection
      return { ok: true, connection }
    } catch {
      return fail('save_failed')
    }
  }
}
