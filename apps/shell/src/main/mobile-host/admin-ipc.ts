import { dialog, ipcMain, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import QRCode from 'qrcode'
import { encodePairingInvitation } from '@bigdogoffice/remote-core/pairing'
import type { HostServerApi, HostIdentity } from '@bigdogoffice/remote-core/transport'
import { assertTrustedSettingsSender } from '../trusted-settings-sender'
import { REMOTE_ADMIN_CHANNELS, type RemoteAdminStatus } from '../../shared/mobile-host-api'
import type { MobileDevHost } from './server'
export function registerRemoteAdmin(options: {
  contents(): WebContents | undefined
  host(): MobileDevHost | null
  status(): Pick<RemoteAdminStatus, 'online' | 'serverUrl' | 'name'>
  remote?(): { api: HostServerApi; identity: HostIdentity } | null
}) {
  let latestQr: { png: string; expiresAt: number } | undefined
  ipcMain.handle(REMOTE_ADMIN_CHANNELS.status, (event) => {
    assertTrustedSettingsSender(event, options.contents())
    const host = options.host()
    return {
      enabled: Boolean(host),
      ...options.status(),
      invitationState: host?.invitationState(),
      devices: (host?.identities?.list() ?? []).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        revoked: Boolean(row.revoked),
        lastSeen: Number(row.lastSeen),
      })),
    } satisfies RemoteAdminStatus
  })
  ipcMain.handle(REMOTE_ADMIN_CHANNELS.invite, async (event) => {
    assertTrustedSettingsSender(event, options.contents())
    const host = options.host()
    if (!host) throw new Error('REMOTE_DISABLED')
    latestQr = undefined
    const remote = options.remote?.()
    if (!remote) return host.createInvitation()
    const ticket = await remote.api.createPairing()
    const local = host.createInvitation()
    const expiresAt = Math.min(ticket.expiresAt, local.expiresAt)
    const code = encodePairingInvitation({
      v: 1,
      server: remote.api.baseUrl,
      host: remote.identity.deviceId,
      name: remote.identity.name,
      key: remote.identity.publicKey,
      code: local.code,
      ticket: ticket.ticket,
      expires: expiresAt,
    })
    const qrDataUrl = await QRCode.toDataURL(code, {
      width: 640,
      margin: 3,
      errorCorrectionLevel: 'M',
    })
    latestQr = { png: qrDataUrl, expiresAt }
    return { code, expiresAt, qrDataUrl }
  })
  ipcMain.handle(REMOTE_ADMIN_CHANNELS.saveQr, async (event) => {
    assertTrustedSettingsSender(event, options.contents())
    const current = latestQr
    if (!current || current.expiresAt <= Date.now()) throw new Error('PAIRING_EXPIRED')
    const result = await dialog.showSaveDialog({
      title: '保存手机配对二维码',
      defaultPath: '大狗手机配对.png',
      filters: [{ name: 'PNG', extensions: ['png'] }],
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, Buffer.from(current.png.split(',')[1]!, 'base64'))
    return true
  })
  ipcMain.handle(REMOTE_ADMIN_CHANNELS.revoke, (event, id: unknown) => {
    assertTrustedSettingsSender(event, options.contents())
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('INVALID_DEVICE')
    options.host()?.identities?.revoke(id)
  })
}
