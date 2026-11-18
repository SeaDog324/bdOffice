import { ipcMain, shell, type WebContents } from 'electron'
import { CONNECTION_SETUP_CHANNELS } from '../shared/connection-setup-api'
import { ConnectionSetupService } from './connection-setup'
import { assertTrustedSettingsSender } from './trusted-settings-sender'

export function registerConnectionSetupIpc(
  service: ConnectionSetupService,
  contents: () => WebContents | undefined,
): void {
  const observed = new WeakSet<WebContents>()
  const handle = (channel: string, run: (owner: number, input: unknown) => unknown) => {
    ipcMain.handle(channel, (event, input: unknown) => {
      assertTrustedSettingsSender(event, contents())
      if (!observed.has(event.sender)) {
        observed.add(event.sender)
        event.sender.once('destroyed', () => service.release(event.sender.id))
      }
      return run(event.sender.id, input)
    })
  }
  handle(CONNECTION_SETUP_CHANNELS.inspect, () => service.inspect())
  handle(CONNECTION_SETUP_CHANNELS.openHelp, (_owner, page) => {
    if (page !== 'deepseek-platform' && page !== 'deepseek-docs')
      throw new Error('Invalid help page.')
    return shell.openExternal(
      page === 'deepseek-platform'
        ? 'https://platform.deepseek.com/'
        : 'https://api-docs.deepseek.com/',
    )
  })
  handle(CONNECTION_SETUP_CHANNELS.test, (owner, input) => service.test(owner, input))
  handle(CONNECTION_SETUP_CHANNELS.commit, (owner, input) => service.commit(owner, input))
  handle(CONNECTION_SETUP_CHANNELS.cancel, (owner, input) => {
    if (typeof input !== 'string' || input.length > 128)
      throw new Error('Invalid connection test ID.')
    service.cancel(owner, input)
  })
}
