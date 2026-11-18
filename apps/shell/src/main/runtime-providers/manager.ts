import { join } from 'node:path'
import type {
  AgentRuntimeSelection,
  ProviderStatus,
  RuntimeProvider,
  RuntimeProviderId,
  RuntimeProvidersSnapshot,
} from '../../shared/runtime-provider-api'
import { isAgentRuntimeSelection } from '../../shared/runtime-provider-api'
import { ClaudeRuntimeProvider } from './claude-runtime-provider'
import { CodexRuntimeProvider } from './codex-runtime-provider'

interface RuntimeProviderManagerOptions {
  userDataPath: string
  appVersion: string
  openExternal(url: string): Promise<unknown>
  readSelection(): unknown
  writeSelection(selection: AgentRuntimeSelection): void
  providers?: readonly RuntimeProvider[]
}

interface LogoutRuntimeProvider extends RuntimeProvider {
  logout(): Promise<void>
}

function supportsLogout(provider: RuntimeProvider): provider is LogoutRuntimeProvider {
  return 'logout' in provider && typeof provider.logout === 'function'
}

export class RuntimeProviderManager {
  private readonly providers: Map<RuntimeProviderId, RuntimeProvider>
  private readonly sessions = new Set<RuntimeProvider>()
  private readonly changing = new Set<RuntimeProviderId>()
  private disposed = false

  constructor(private readonly options: RuntimeProviderManagerOptions) {
    const runtimeRoot = join(options.userDataPath, 'runtime')
    const providers = options.providers ?? [
      new CodexRuntimeProvider({
        root: join(runtimeRoot, 'codex'),
        appVersion: options.appVersion,
        openExternal: options.openExternal,
      }),
      new ClaudeRuntimeProvider(),
    ]
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
  }

  selection(): AgentRuntimeSelection {
    const value = this.options.readSelection()
    if (value === undefined || value === null || value === '') return 'api'
    if (!isAgentRuntimeSelection(value))
      throw new Error('Invalid account selection. Choose a connection in Settings.')
    return value
  }

  activeProvider(): RuntimeProvider | null {
    const selection = this.selection()
    return selection === 'api' ? null : this.required(selection)
  }

  /** Independent connections avoid deadlocking an outer tool that requests a model itself. */
  acquire(): { provider: RuntimeProvider; release(): Promise<void> } | null {
    const selected = this.activeProvider()
    if (!selected) return null
    if (this.disposed || this.changing.has(selected.id))
      throw new Error('Account connection is changing. Please try again shortly.')
    if (this.sessions.size >= 8)
      throw new Error('Too many active requests. Please wait for one to finish.')
    const provider = selected.fork?.() ?? selected
    if (provider === selected) return { provider, async release() {} }
    this.sessions.add(provider)
    let released = false
    return {
      provider,
      release: async () => {
        if (released) return
        released = true
        try {
          await provider.dispose?.()
        } finally {
          this.sessions.delete(provider)
        }
      },
    }
  }

  private async change<T>(id: RuntimeProviderId, action: () => Promise<T>): Promise<T> {
    if (this.changing.has(id)) throw new Error('Account connection is already being updated.')
    this.changing.add(id)
    try {
      await Promise.all(
        [...this.sessions]
          .filter((provider) => provider.id === id)
          .map(async (provider) => {
            await provider.dispose?.()
            this.sessions.delete(provider)
          }),
      )
      return await action()
    } finally {
      this.changing.delete(id)
    }
  }

  async snapshot(): Promise<RuntimeProvidersSnapshot> {
    const statuses = await Promise.all(
      [...this.providers.values()].map(async (provider): Promise<ProviderStatus> => {
        try {
          return await provider.status()
        } catch (error) {
          return {
            id: provider.id,
            label: provider.id === 'codex' ? 'ChatGPT / Codex' : 'Claude',
            phase: 'error',
            installed: false,
            authenticated: false,
            ready: false,
            capabilities: provider.capabilities,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
    return { selection: this.selection(), providers: statuses }
  }

  async connect(id: RuntimeProviderId): Promise<RuntimeProvidersSnapshot> {
    await this.change(id, async () => {
      const provider = this.required(id)
      if (!(await provider.detect())) await provider.install()
      await provider.login()
      const status = await provider.status()
      if (!status.ready) throw new Error(`${status.label} is not ready.`)
      this.options.writeSelection(id)
    })
    return this.snapshot()
  }

  async install(id: RuntimeProviderId): Promise<RuntimeProvidersSnapshot> {
    await this.change(id, () => this.required(id).install())
    return this.snapshot()
  }

  async login(id: RuntimeProviderId): Promise<RuntimeProvidersSnapshot> {
    await this.change(id, async () => {
      const provider = this.required(id)
      await provider.login()
      const status = await provider.status()
      if (status.ready) this.options.writeSelection(id)
    })
    return this.snapshot()
  }

  async select(selection: AgentRuntimeSelection): Promise<RuntimeProvidersSnapshot> {
    if (selection !== 'api') {
      const status = await this.required(selection).status()
      if (!status.ready) throw new Error(`${status.label} is not connected.`)
    }
    this.options.writeSelection(selection)
    return this.snapshot()
  }

  async logout(id: RuntimeProviderId): Promise<RuntimeProvidersSnapshot> {
    await this.change(id, async () => {
      const provider = this.required(id)
      await provider.cancel()
      if (supportsLogout(provider)) await provider.logout()
    })
    // Signing out never implicitly opts the user into API charges.
    return this.snapshot()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all(
      [...this.providers.values(), ...this.sessions].map((provider) =>
        provider.dispose?.().catch(() => {}),
      ),
    )
    this.sessions.clear()
  }

  private required(id: RuntimeProviderId): RuntimeProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new Error(`Unknown Runtime Provider: ${id}.`)
    return provider
  }
}
