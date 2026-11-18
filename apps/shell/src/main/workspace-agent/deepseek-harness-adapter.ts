import {
  AgentLoop,
  type AgentLoopEvents,
  type AgentSkill,
  type AgentTransport,
} from '@genoffice/agent-core'
import {
  activeProvider,
  defaultAiSettings,
  clampMaxOutputTokens,
  maxOutputTokensOf,
  resolveAiSettings,
  streamForProvider,
  type AiSettings,
} from '@genoffice/ai-provider'
import { HarnessToolRegistry } from './tool-registry'
import type { HarnessAgentAdapter, HarnessLoopOptions, HarnessToolContext } from './harness-types'
import type { RuntimeProvider } from '../../shared/runtime-provider-api'
import { createRuntimeProviderTransport } from './runtime-provider-transport'
import { accountErrorText } from '../../shared/account-copy'

export interface DeepSeekHarnessAdapterOptions {
  /** Injectable transport used by tests and by future remote Harness clients. */
  transport?: AgentTransport
  /** Local official runtime selected by the user, or null for the API path. */
  runtimeProvider?(): RuntimeProvider | null
  readAiSettings?(): AiSettings
  readLanguage?(): string
  /** Provider output cap for one model turn. */
  maxOutputTokens?: number
  registry?: HarnessToolRegistry
}

/**
 * First-party Harness adapter for the desktop runtime.
 *
 * There is intentionally no DeepSeek SDK type in the business layer. This
 * adapter translates the Harness session/tool contract to the existing
 * AgentLoop and provider stream. A hosted DeepSeek Harness implementation can
 * replace this class while WorkspaceAgentRuntime keeps the same API.
 */
export class DeepSeekHarnessAdapter implements HarnessAgentAdapter {
  readonly id = 'deepseek-harness'
  readonly registry: HarnessToolRegistry
  private readonly options: DeepSeekHarnessAdapterOptions

  constructor(options: DeepSeekHarnessAdapterOptions = {}) {
    this.options = options
    this.registry = options.registry ?? new HarnessToolRegistry()
  }

  createTransport(): AgentTransport {
    const fallback = this.options.transport ?? this.createDeepSeekTransport()
    return this.options.runtimeProvider
      ? createRuntimeProviderTransport({
          fallback,
          getProvider: this.options.runtimeProvider,
          formatError: (error) => accountErrorText(error, this.options.readLanguage?.()),
        })
      : fallback
  }

  /** Build an AgentLoop whose execute path always goes through Tool Registry. */
  createLoop<TSnapshot = unknown>(
    options: HarnessLoopOptions<TSnapshot> & {
      registry?: HarnessToolRegistry
      toolContext?: HarnessToolContext
    },
  ): AgentLoop<TSnapshot> {
    const registry = options.registry ?? this.registry
    // AgentSkill definitions are the source of the JSON schemas. A per-session
    // registry can provide different executors while retaining plugin hooks.
    for (const definition of options.skill.tools) {
      if (!registry.has(definition.name)) {
        registry.register(definition, (call, context) =>
          options.skill.executeTool(call, context.signal),
        )
      }
    }
    // `registry` intentionally contains compatibility aliases and internal
    // plugin registrations. The skill's tool list is the model-facing allow
    // list; exposing the whole registry here would defeat the P0 schema cap.
    const exposedTools = options.skill.tools.length
      ? options.skill.tools.map((definition) => ({
          ...definition,
          inputSchema: { ...definition.inputSchema },
        }))
      : registry.definitions()
    const harnessSkill: AgentSkill = {
      ...options.skill,
      get tools() {
        return exposedTools
      },
      executeTool: (call, signal) =>
        registry.execute(call, {
          ...(options.toolContext ?? {}),
          signal,
        }),
    }
    return new AgentLoop<TSnapshot>({
      taskExecution: options.taskExecution,
      transport: options.transport ?? this.createTransport(),
      skill: harnessSkill,
      events: options.events as AgentLoopEvents<TSnapshot> | undefined,
      maxTurns: options.maxTurns,
      maxHistory: options.maxHistory,
      runTimeoutMs: options.runTimeoutMs,
      runTimeoutError: options.runTimeoutError,
      compaction: options.compaction,
      captureSnapshot: options.captureSnapshot,
      formatUserMessage: options.formatUserMessage,
      systemSuffix: options.systemSuffix,
    })
  }

  /** Exposed for diagnostics and tests; provider selection still follows the
   * user's configured AI settings for backwards compatibility. */
  providerName(): string {
    const settings = this.settings()
    return activeProvider(settings)
  }

  private settings(): AiSettings {
    try {
      return resolveAiSettings(this.options.readAiSettings?.() ?? {}, defaultAiSettings())
    } catch {
      return defaultAiSettings()
    }
  }

  private createDeepSeekTransport(): AgentTransport {
    return {
      stream: (request, callbacks) => {
        const controller = new AbortController()
        const settings = this.settings()
        const provider = activeProvider(settings)
        const config = settings.providers[provider]
        if (!config?.apiKey) {
          queueMicrotask(() =>
            callbacks.onError('AI provider is not configured. Add an API key in Settings.'),
          )
        } else if (!config.model) {
          queueMicrotask(() => callbacks.onError('AI model is not configured.'))
        } else {
          void streamForProvider(
            provider,
            config,
            request.system,
            request.messages,
            request.tools,
            this.options.maxOutputTokens === undefined
              ? maxOutputTokensOf(settings)
              : clampMaxOutputTokens(this.options.maxOutputTokens),
            {
              signal: controller.signal,
              onDelta: callbacks.onDelta,
              onUsage: callbacks.onUsage,
              onReasoningDelta: callbacks.onReasoning,
              onToolCall: callbacks.onToolCall,
              onStopReason: callbacks.onStopReason,
              onActivity: callbacks.onPhase
                ? () => callbacks.onPhase!({ kind: 'thinking' })
                : undefined,
            },
          ).then(callbacks.onDone, (error) => {
            if (controller.signal.aborted) callbacks.onDone()
            else callbacks.onError(error instanceof Error ? error.message : String(error))
          })
        }
        return { cancel: () => controller.abort() }
      },
    }
  }
}

export type { HarnessToolContext }
