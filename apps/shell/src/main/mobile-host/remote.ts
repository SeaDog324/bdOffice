import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HostServerApi, startRemoteHost, type SecureSettings } from '@bigdogoffice/remote-core/host'
import { loadTransportIdentity } from '@bigdogoffice/remote-core/transport'
import { openOffline } from '@bigdogoffice/remote-core/offline'
import type { MobileDevHost } from './server'
import type { AssistantTaskService } from '../agent-tasks/service'
import type { RemoteOwnership } from './ownership'
import { SessionHandoff } from './handoff'
import { sessionStoreFor } from '@genoffice/project-store'

interface RemoteConfig {
  serverUrl: string
  account?: string
  password?: string
  name?: string
  pairingCode: string
  forceRelay?: boolean
}
export function readRemoteConfig(path: string): RemoteConfig {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (
    !value ||
    typeof value.serverUrl !== 'string' ||
    typeof value.pairingCode !== 'string' ||
    value.pairingCode.length < 6 ||
    value.pairingCode.length > 128 ||
    /\s/.test(value.pairingCode)
  )
    throw new Error('Invalid Remote configuration')
  return value
}
/** Transport identity and refresh credentials use the OS vault, independently of model settings. */
export class RemoteVault implements SecureSettings {
  private readonly values: Record<string, string>
  constructor(private readonly path: string) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('OS credential protection unavailable')
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
      throw new Error('An OS keyring is required')
    this.values = existsSync(path) ? JSON.parse(safeStorage.decryptString(readFileSync(path))) : {}
  }
  async get(key: string) {
    return this.values[key] || undefined
  }
  async set(key: string, value: string) {
    const next = { ...this.values, [key]: value }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path + '.pending', safeStorage.encryptString(JSON.stringify(next)), {
      mode: 0o600,
    })
    renameSync(this.path + '.pending', this.path)
    this.values[key] = value
  }
}
export async function connectDesktopRemote(
  config: RemoteConfig,
  userData: string,
  port: number,
  gateway: MobileDevHost,
  tasks: AssistantTaskService,
  ownership: RemoteOwnership,
  sessionIds: string[],
) {
  const storage = new RemoteVault(join(userData, 'mobile', 'transport.vault'))
  const identity = await loadTransportIdentity(storage, config.name || '大狗电脑')
  const api = new HostServerApi(config.serverUrl, storage, 'host')
  try {
    await api.authenticate(identity)
  } catch (error) {
    if (!config.account || !config.password) throw error
    await api.authorize(identity, config.account, config.password)
  }
  ownership.configure(api)
  for (const id of sessionIds.slice(0, 100)) await ownership.ensure(id).catch(() => {})
  const host = await startRemoteHost({
    api,
    identity,
    storage,
    port,
    forceRelay: config.forceRelay,
    authorizedPeer: (id, key, device) => gateway.identities!.bindCarrier(id, key, device),
  })
  const handoff = new SessionHandoff(
    join(userData, 'mobile', 'handoffs'),
    sessionStoreFor(userData),
    tasks,
    ownership,
    api,
    identity.deviceId,
    (id) => gateway.exportResults(id),
    (id) => gateway.prepareExport(id),
    (id) => gateway.prepareImport(id),
  )
  let stopped = false,
    working = false
  const poll = async () => {
    if (stopped || working) return
    working = true
    try {
      writeFileSync(
        join(userData, 'mobile', 'connection-status.json'),
        JSON.stringify({
          online: host.isOnline(),
          routes: host.connectionModes().map((item) => item.mode),
          updatedAt: new Date().toISOString(),
        }),
      )
      await ownership.renew()
      await handoff.reconcile()
      const inbox = await api.courier('inbox')
      for (const item of inbox.items) {
        try {
          const peer = await api.deviceFor(item.envelope.sender)
          const command = openOffline(identity, peer.identityKey, item.envelope, api.baseUrl) as {
            text?: unknown
          }
          if (typeof command.text !== 'string') throw new Error('INVALID_COMMAND')
          const owner = await api.courier('owner/' + item.envelope.sessionId)
          if (
            owner?.host !== identity.deviceId ||
            owner.epoch !== item.envelope.epoch ||
            owner.state !== 'active'
          )
            throw new Error('OWNER_CHANGED')
          await ownership.ensure(item.envelope.sessionId)
          const receipt = await gateway.acceptOffline(
            peer.deviceId,
            peer.identityKey,
            item.envelope.sessionId,
            item.envelope.requestId,
            command.text,
          )
          gateway.identities!.courierTask(item.id, receipt.taskId)
          await api.courier('receipt', {
            id: item.id,
            state: 'accepted',
            taskId: receipt.taskId,
            revision: 0,
          })
        } catch (error) {
          const code =
            (error as { code?: string })?.code || (error instanceof Error ? error.message : '')
          if (
            [
              'DEVICE_REVOKED',
              'INVALID_COMMAND',
              'COMMAND_EXPIRED',
              'OWNER_CHANGED',
              'SESSION_NOT_FOUND',
              'SESSION_INACTIVE',
              'REQUEST_CONFLICT',
            ].includes(code)
          )
            await api.courier('receipt', { id: item.id, state: 'rejected', revision: 0 })
        }
      }
      for (const row of gateway.identities!.courierTasks()) {
        try {
          const task = tasks.store.get(String(row.taskId))
          if (task.revision <= Number(row.revision)) continue
          const state = [
            'completed',
            'failed',
            'waiting_user',
            'interrupted',
            'cancelled',
          ].includes(task.state)
            ? task.state
            : 'accepted'
          await api.courier('receipt', {
            id: Number(row.messageId),
            state,
            taskId: task.id,
            revision: task.revision,
          })
          gateway.identities!.courierRevision(Number(row.messageId), task.revision)
        } catch (error) {
          if (error instanceof Error && error.message === 'unknown_assistant_task') {
            await api.courier('receipt', {
              id: Number(row.messageId),
              state: 'cancelled',
              revision: Math.max(0, Number(row.revision) + 1),
            })
            gateway.identities!.forgetCourierTask(Number(row.messageId))
          }
        }
      }
    } catch {
      /* Durable inbox remains pending; the next poll revalidates authority. */
    } finally {
      working = false
    }
  }
  const timer = setInterval(() => {
    void poll()
  }, 4000)
  timer.unref()
  void poll()
  // Public pairing metadata only. Secrets remain in the supplied configuration/OS vault.
  writeFileSync(
    join(userData, 'mobile', 'connection.json'),
    JSON.stringify(
      {
        serverUrl: config.serverUrl,
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        name: identity.name,
      },
      null,
      2,
    ),
  )
  return {
    host,
    api,
    identity,
    ownership,
    handoff,
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await host.stop()
    },
  }
}
