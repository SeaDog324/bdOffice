import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function isEphemeralInstall(resourcesPath: string, env: NodeJS.ProcessEnv): boolean {
  if (env.APPIMAGE) return true
  return /^\/Volumes\//.test(resourcesPath) || /\/\.mount_[^/]+\//.test(resourcesPath)
}

/** CLI discovery/audit files are separate from all vendor OAuth credential stores. */
export function launcherFilePath(env: NodeJS.ProcessEnv): string {
  return join(env.BIGDOGOFFICE_CLI_DIR || join(homedir(), '.bigdogoffice'), 'launcher')
}

/** Called only by explicit integration actions; never rewrites PATH at startup. */
export function writeLauncherFile(file: string, launcherDir: string): boolean {
  const content = `${launcherDir}\n`
  try {
    if (readFileSync(file, 'utf-8') === content) return false
  } catch {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, { encoding: 'utf-8', mode: 0o600 })
  return true
}
