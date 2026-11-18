// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Ambient optional native dependency; no runtime import.
/// <reference path="./optional-native.d.ts" />
import { createRpcResponse, createRpcError, type RemoteMessage } from '@dsh-remote/protocol'
import { HostServerConnection } from './vendor/dsh-host/server-connection'
import { loadWeriftFactory } from './vendor/dsh-host/werift-rtc'
import type { PeerChannel, TrustedPeer, HostIdentity, SafeLogger } from './host-ports'
import { HostServerApi, type SecureSettings } from './server-api'
export { HostServerApi }
export type { HostIdentity, SecureSettings }

/** Carrier peers can reach only the authenticated mobile API, never arbitrary URLs or desktop IPC. */
export async function startRemoteHost(options: {
  api: HostServerApi
  identity: HostIdentity
  storage: SecureSettings
  port: number
  forceRelay?: boolean
  logger?: SafeLogger
  authorizedPeer?(peerId: string, peerKey: string, mobileDeviceId: string): void
}) {
  const channels = new Map<string, PeerChannel>()
  const saved = await options.storage.get('trusted-noise-peers')
  const peers: Record<string, TrustedPeer> = saved ? JSON.parse(saved) : {}
  let saveTail = Promise.resolve()
  const muted: SafeLogger = { debug() {}, info() {}, warn() {}, error() {} }
  const host = new HostServerConnection(
    {
      forceRelay: options.forceRelay ?? false,
      rotatePinnedPeerKey: false,
      reconnect: { enabled: true, maxDelayMs: 5000 },
    },
    options.identity,
    {
      trustedPeer: (id) => peers[id],
      trustPeer: async (peer) => {
        peers[peer.deviceId] = peer
        saveTail = saveTail.then(() =>
          options.storage.set('trusted-noise-peers', JSON.stringify(peers)),
        )
        await saveTail
        return peer
      },
    },
    options.api,
    {
      accept: async (channel) => {
        channels.set(channel.security.connectionId, channel)
        channel.onMessage((message) => {
          void route(channel, message).catch(() => channel.close('RPC_FAILURE'))
        })
      },
      close: async () => {
        const old = [...channels.values()]
        channels.clear()
        await Promise.allSettled(old.map((c) => c.close()))
      },
      closeConnection: async (id, code) => {
        const channel = channels.get(id)
        if (!channel) return false
        channels.delete(id)
        await channel.close(code)
        return true
      },
    },
    options.logger ?? muted,
    undefined,
    () => loadWeriftFactory(),
    () => ['plugin.route.v1'],
  )
  async function route(channel: PeerChannel, message: RemoteMessage) {
    if (message.type !== 'rpc.request') return
    try {
      const payload = message.payload as { method?: string; params?: Record<string, unknown> }
      const params = payload.params
      if (
        payload.method !== 'plugin.route.call' ||
        !params ||
        params.plugin !== 'bigdogoffice' ||
        !['GET', 'POST'].includes(String(params.method)) ||
        typeof params.path !== 'string' ||
        !/^\/mobile\/v1\/(health|challenge|resume|pair|rpc)$/.test(params.path)
      )
        throw new Error('METHOD_NOT_SUPPORTED')
      const headers = params.headers as Record<string, unknown> | undefined
      if (
        headers &&
        (typeof headers !== 'object' ||
          Object.keys(headers).some((k) => !['Authorization', 'authorization'].includes(k)))
      )
        throw new Error('INVALID_HEADERS')
      const authorization = headers?.Authorization ?? headers?.authorization
      if (
        authorization !== undefined &&
        (typeof authorization !== 'string' ||
          authorization.length > 150 ||
          /[\r\n]/.test(authorization))
      )
        throw new Error('INVALID_AUTH')
      const body = params.data === undefined ? undefined : JSON.stringify(params.data)
      if (body && Buffer.byteLength(body) > 1024 * 1024) throw new Error('REQUEST_TOO_LARGE')
      const result = await fetch(`http://127.0.0.1:${options.port}${params.path}`, {
        method: String(params.method),
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization: String(authorization) } : {}),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(
          (params.data as { method?: string } | undefined)?.method === 'artifacts.preview'
            ? 175_000
            : 25_000,
        ),
      })
      const data = await result.json()
      if (
        result.ok &&
        ['/mobile/v1/pair', '/mobile/v1/resume'].includes(params.path) &&
        typeof data.deviceId === 'string'
      )
        options.authorizedPeer?.(channel.peerDeviceId, channel.peerIdentityKey, data.deviceId)
      await channel.send(createRpcResponse(message.id, { statusCode: result.status, data }))
    } catch {
      await channel.send(
        createRpcError(
          message.id,
          'INVALID_MESSAGE',
          'The mobile request could not be completed.',
          false,
        ),
      )
    }
  }
  host.start()
  return Object.assign(host, {
    connectionModes: () =>
      [...channels.values()].map((channel) => ({
        mode: channel.mode,
        peerDeviceId: channel.peerDeviceId,
      })),
  })
}
