import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { rendererUrl, type RendererHost } from './renderer-scheme'
import type { StandaloneAppIpcMainLike } from './standalone-ipc'

export type EditorApprovalMode = 'auto' | 'per-action'
interface ApprovalHost {
  rendererHost?: RendererHost
  renderer?(): { rendererUrl?: string | undefined; rendererFile?: string | undefined }
  acceptsSender?(id: number): boolean
  broadcast?(mode: EditorApprovalMode): void
  onModeChanged?(mode: EditorApprovalMode): void
}
interface ApprovalState {
  settingsPath(): string
  hosts: Set<ApprovalHost>
}
const registered = new WeakMap<object, ApprovalState>()

function readSettings(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid app settings; approval mode was not changed.')
  return value as Record<string, unknown>
}

/** Main-process only: one validated, atomic setting update shared with Shell. */
export function setEditorApprovalMode(ipcMain: object, mode: unknown): EditorApprovalMode {
  if (mode !== 'auto' && mode !== 'per-action') throw new Error('Invalid Agent approval mode.')
  const state = registered.get(ipcMain)
  if (!state) throw new Error('Editor approval is unavailable.')
  const path = state.settingsPath()
  let settings: Record<string, unknown>
  try {
    settings = readSettings(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    settings = {}
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ ...settings, agentApprovalMode: mode }, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
    })
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Only remove this write's temporary file, if it was created.
    }
    throw error
  }
  // Persist before releasing any pending call. A closed renderer must not
  // make a successful settings write look like a failed one.
  for (const host of state.hosts) {
    try {
      host.onModeChanged?.(mode)
    } catch {
      // Each subsequent tool still reads the persisted mode afresh.
    }
  }
  try {
    ;[...state.hosts].find((host) => host.broadcast)?.broadcast?.(mode)
  } catch {
    // The next mount/action re-reads the authoritative setting.
  }
  return mode
}

function sameRenderer(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual)
    const b = new URL(expected)
    a.hash = b.hash = ''
    a.search = b.search = ''
    return a.href === b.href
  } catch {
    return false
  }
}

/** Only the approval enum is writable, from registered first-party renderers.
 * Never expose arbitrary settings or credentials to an editor renderer. */
export function registerEditorApprovalIpc(
  ipcMain: StandaloneAppIpcMainLike,
  settingsPath: () => string,
  host?: ApprovalHost,
): void {
  const existing = registered.get(ipcMain)
  if (existing) {
    if (host) existing.hosts.add(host)
    return
  }
  const state: ApprovalState = { settingsPath, hosts: new Set(host ? [host] : []) }
  registered.set(ipcMain, state)
  ipcMain.handle('agent:editor-approval-mode', () => {
    try {
      const settings = readSettings(settingsPath())
      return settings.agentApprovalMode === 'auto' ? 'auto' : 'per-action'
    } catch {
      return 'per-action'
    }
  })
  ipcMain.handle('agent:set-editor-approval-mode', (event, mode) => {
    const source = event as typeof event & {
      sender: { getURL?(): string }
      senderFrame?: { parent: unknown } | null
    }
    if (source.senderFrame?.parent) throw new Error('Approval mode requires the main frame.')
    const allowed = [...state.hosts].some((entry) => {
      if (entry.acceptsSender?.(event.sender.id)) return true
      const renderer = entry.renderer?.()
      const expected =
        renderer?.rendererUrl ||
        (entry.rendererHost
          ? rendererUrl(undefined, entry.rendererHost)
          : renderer?.rendererFile
            ? pathToFileURL(renderer.rendererFile).href
            : '')
      const actual = source.sender.getURL?.() ?? ''
      const legacy =
        !renderer?.rendererUrl && renderer?.rendererFile
          ? pathToFileURL(renderer.rendererFile).href
          : ''
      return (
        (!!expected && sameRenderer(actual, expected)) || (!!legacy && sameRenderer(actual, legacy))
      )
    })
    if (!allowed) throw new Error('Untrusted editor approval sender.')
    return setEditorApprovalMode(ipcMain, mode)
  })
}
