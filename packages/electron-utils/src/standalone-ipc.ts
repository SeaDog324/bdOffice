import { readFileSync } from 'node:fs'

export type UiThemePreference = 'light' | 'dark' | 'system'

export interface StandaloneAppIpcMainLike {
  handle(
    channel: string,
    listener: (event: { sender: { id: number } }, ...args: unknown[]) => unknown,
  ): void
}

const registeredThemeIpc = new WeakSet<object>()

/** Read the shell-compatible theme preference from app-settings.json. */
export function readUiThemePreference(settingsPath: string): UiThemePreference {
  try {
    const value = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { theme?: unknown }).theme
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** Register app:get-theme once for an editor running without the shell host. */
export function registerStandaloneThemeIpc(
  ipcMain: StandaloneAppIpcMainLike,
  getTheme: () => UiThemePreference,
): boolean {
  const key = ipcMain as object
  if (registeredThemeIpc.has(key)) return false
  registeredThemeIpc.add(key)
  ipcMain.handle('app:get-theme', () => getTheme())
  return true
}
