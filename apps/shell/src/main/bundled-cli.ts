import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createCliRunner, type CliRunner, type CliRunnerPaths } from './mcp/cli-runner'

export interface BundledCliLayout {
  packaged: boolean
  appPath: string
  resourcesPath: string
  userData: string
  executable: string
  platform: NodeJS.Platform
}

/** One layout/profile contract for Home, editor skills and MCP. */
export function bundledCliPaths(layout: BundledCliLayout): CliRunnerPaths {
  const repository = resolve(layout.appPath, '../..')
  const name = layout.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  const sidecar = layout.packaged
    ? join(layout.resourcesPath, 'native', name)
    : join(repository, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', name)
  return {
    executable: layout.executable,
    entry: layout.packaged
      ? join(layout.resourcesPath, 'cli', 'bigdogoffice.cjs')
      : join(repository, 'packages', 'cli', 'dist', 'bigdogoffice.cjs'),
    env: {
      GENOFFICE_USER_DATA: layout.userData,
      ...(existsSync(sidecar) ? { XLSX_SIDECAR_PATH: sidecar } : {}),
    },
  }
}

export function createAppCliRunner(): CliRunner {
  return createCliRunner(
    bundledCliPaths({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userData: app.getPath('userData'),
      executable: process.execPath,
      platform: process.platform,
    }),
  )
}
