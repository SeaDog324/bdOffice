import { ipcMain, type WebContents } from 'electron'
import type { ComputerUseService } from '@bigdogoffice/computer-use'
import { COMPUTER_USE_CHANNELS } from '../shared/computer-use-api'
import { assertTrustedSettingsSender } from './trusted-settings-sender'

/** Renderer controls the lifecycle only. All desktop actions go through the Agent Harness. */
export function registerComputerUseIpc(options: {
  contents(): WebContents | undefined
  service(): ComputerUseService
}): void {
  for (const method of ['status', 'restart', 'stop'] as const)
    ipcMain.handle(COMPUTER_USE_CHANNELS[method], async (event) => {
      assertTrustedSettingsSender(event, options.contents())
      try {
        return await options.service()[method]()
      } catch {
        throw new Error('computer_operation_failed')
      }
    })
}
