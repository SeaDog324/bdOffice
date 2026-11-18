import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeLauncherFile } from '../cli-link'
import type { RepairActionId, EnvironmentCheck } from '../../shared/environment-api'
import type { EnvironmentAdapter, EnvironmentInspection, RepairResource } from './service'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return (
    rel === '' ||
    (!rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))
  )
}
async function existsFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}
export interface LocalEnvironmentOptions {
  userData: string
  cliEntry: string
  cliDirectory: string
  discoveryFile: string
  nativeBinary: string
  rendererFiles: string[]
  ephemeral: boolean
  connection(): Promise<{ usable: boolean }>
  index(): Promise<{ ready: boolean; repairable: boolean; version: string }>
  rebuildIndex(): Promise<void>
  probeCli?(): Promise<boolean>
  probeNative?(): Promise<boolean>
  probeComputer?(): Promise<{ available: boolean }>
}

/** Fixed local resources only. Neither IPC nor model tools can supply paths or shell commands. */
export class LocalEnvironmentAdapter implements EnvironmentAdapter {
  private readonly directories: string[]
  private cliProbe: Promise<boolean> | null = null
  private nativeProbe: Promise<boolean> | null = null
  constructor(private readonly options: LocalEnvironmentOptions) {
    this.directories = [
      'workspace-agent/sessions',
      'workspace-agent/runs',
      'agent-sessions/sessions',
    ].map((part) => join(options.userData, part))
  }
  refresh(): void {
    this.cliProbe = null
    this.nativeProbe = null
  }
  private async safeOwnedPath(path: string): Promise<void> {
    const root = await realpath(this.options.userData)
    const relativePath = relative(resolve(this.options.userData), resolve(path))
    if (!inside(resolve(this.options.userData), resolve(path)))
      throw new Error('unsafe_environment_path')
    let current = resolve(this.options.userData)
    for (const segment of relativePath.split(sep).filter(Boolean)) {
      current = join(current, segment)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new Error('unsafe_environment_path')
        if (!inside(root, await realpath(current))) throw new Error('unsafe_environment_path')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  private async storage(): Promise<RepairResource> {
    let missing = false
    try {
      for (const path of this.directories) {
        await this.safeOwnedPath(path)
        try {
          if (!(await lstat(path)).isDirectory())
            return { state: 'blocked', version: 'not_directory' }
          await access(path, constants.R_OK | constants.W_OK)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          missing = true
          let ancestor = dirname(path)
          while (true) {
            try {
              await access(ancestor, constants.W_OK | constants.R_OK)
              break
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              const parent = dirname(ancestor)
              if (parent === ancestor) throw error
              ancestor = parent
            }
          }
        }
      }
      return { state: missing ? 'repairable' : 'ready', version: hash(this.directories) }
    } catch {
      return { state: 'blocked', version: 'storage_unavailable' }
    }
  }
  private async discovery(): Promise<RepairResource> {
    const file = this.options.discoveryFile
    if (this.options.ephemeral) return { state: 'blocked', version: 'ephemeral_install' }
    try {
      try {
        if ((await lstat(dirname(file))).isSymbolicLink())
          return { state: 'blocked', version: 'custom_launcher' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
        return { state: 'blocked', version: 'custom_launcher' }
      const value = (await readFile(file, 'utf8')).trim()
      if (!value || !isAbsolute(value) || /[\r\n]/.test(value))
        return { state: 'blocked', version: 'custom_launcher' }
      if (resolve(value) === resolve(this.options.cliDirectory))
        return { state: 'ready', version: hash(this.options.cliDirectory) }
      // Keep a functioning custom/other installation. A missing stale target is repairable.
      if (
        (await existsFile(join(value, 'bigdogoffice.cjs'))) ||
        (await existsFile(join(value, 'bigdogoffice.cmd')))
      )
        return { state: 'blocked', version: 'custom_launcher' }
      return {
        state: 'repairable',
        version: hash({ file, value, target: this.options.cliDirectory }),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { state: 'repairable', version: hash({ file, target: this.options.cliDirectory }) }
      return { state: 'blocked', version: 'launcher_unwritable' }
    }
  }
  async inspect(): Promise<EnvironmentInspection> {
    const [storage, discovery, cliPresent, nativePresent, renderers, connection, index] =
      await Promise.all([
        this.storage(),
        this.discovery(),
        existsFile(this.options.cliEntry),
        existsFile(this.options.nativeBinary),
        Promise.all(this.options.rendererFiles.map(existsFile)),
        this.options.connection().catch(() => ({ usable: false })),
        this.options
          .index()
          .catch(() => ({ ready: false, repairable: false, version: 'index_unavailable' })),
      ])
    const cliReady =
      cliPresent &&
      (!this.options.probeCli ||
        (await (this.cliProbe ??= this.options.probeCli().catch(() => false))))
    const nativeReady =
      nativePresent &&
      (!this.options.probeNative ||
        (await (this.nativeProbe ??= this.options.probeNative().catch(() => false))))
    const cache: RepairResource = {
      state: index.ready ? 'ready' : index.repairable ? 'repairable' : 'blocked',
      version: index.version,
    }
    const checks: EnvironmentCheck[] = [
      {
        id: 'storage',
        required: true,
        status:
          storage.state === 'ready'
            ? 'ok'
            : storage.state === 'repairable'
              ? 'unconfigured'
              : 'blocked',
        code:
          storage.state === 'ready'
            ? 'storage_ready'
            : storage.state === 'repairable'
              ? 'storage_lazy'
              : 'storage_unavailable',
        ...(storage.state === 'repairable'
          ? { repairAction: 'ensure_owned_directories' as const }
          : {}),
      },
      {
        id: 'bundled_cli',
        required: true,
        status: cliReady ? 'ok' : 'blocked',
        code: cliReady ? 'cli_ready' : cliPresent ? 'cli_start_failed' : 'cli_missing',
      },
      {
        id: 'cli_discovery',
        required: false,
        status:
          discovery.state === 'ready'
            ? 'ok'
            : discovery.state === 'repairable'
              ? 'unconfigured'
              : 'not_applicable',
        code:
          discovery.state === 'ready'
            ? 'launcher_ready'
            : discovery.state === 'repairable'
              ? 'launcher_needs_update'
              : discovery.version,
        ...(cliReady && discovery.state === 'repairable'
          ? { repairAction: 'repair_owned_cli_link' as const }
          : {}),
      },
      {
        id: 'terminal_entry',
        required: false,
        status: 'not_applicable',
        code: 'terminal_optional',
      },
      {
        id: 'native_engine',
        required: false,
        status: nativeReady ? 'ok' : 'degraded',
        code: nativeReady
          ? this.options.probeNative
            ? 'native_ready'
            : 'native_files_present'
          : nativePresent
            ? 'native_start_failed'
            : 'native_missing',
      },
      {
        id: 'render_resources',
        required: true,
        status: renderers.every(Boolean) ? 'ok' : 'blocked',
        code: renderers.every(Boolean) ? 'render_ready' : 'render_missing',
      },
      {
        id: 'ai_connection',
        required: false,
        status: connection.usable ? 'ok' : 'unconfigured',
        code: connection.usable ? 'ai_configured' : 'ai_unconfigured',
      },
      {
        id: 'search_index',
        required: false,
        status: index.ready ? 'ok' : 'degraded',
        code: index.ready
          ? 'index_ready'
          : index.repairable
            ? 'index_needs_rebuild'
            : 'index_unavailable',
        ...(index.repairable && !index.ready
          ? { repairAction: 'rebuild_owned_derived_cache' as const }
          : {}),
      },
    ]
    if (this.options.probeComputer) {
      const ready = await this.options
        .probeComputer()
        .then((result) => result.available)
        .catch(() => false)
      checks.push({
        id: 'computer_use',
        required: false,
        status: ready ? 'ok' : 'degraded',
        code: ready ? 'computer_ready' : 'computer_unavailable',
      })
    }
    return {
      checks,
      aiAvailable: connection.usable,
      resources: {
        ensure_owned_directories: storage,
        repair_owned_cli_link: cliReady
          ? discovery
          : { state: 'blocked', version: 'cli_unavailable' },
        rebuild_owned_derived_cache: cache,
      },
    }
  }
  async repair(action: RepairActionId): Promise<void> {
    switch (action) {
      case 'ensure_owned_directories':
        for (const path of this.directories) {
          await this.safeOwnedPath(path)
          await mkdir(path, { recursive: true })
        }
        return
      case 'repair_owned_cli_link': {
        const current = await this.discovery()
        if (current.state === 'blocked' || !(await existsFile(this.options.cliEntry)))
          throw new Error('repair_precondition_changed')
        if (current.state === 'ready') return
        writeLauncherFile(this.options.discoveryFile, this.options.cliDirectory)
        return
      }
      case 'rebuild_owned_derived_cache':
        await this.options.rebuildIndex()
        return
      default:
        throw new Error('unsupported_repair')
    }
  }
}
