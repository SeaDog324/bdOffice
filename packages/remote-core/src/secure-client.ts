import { AdaptiveTransport, type RtcPeerConnectionFactory } from '@dsh-remote/webrtc'
import { NoiseIkSession, createNoisePrologue, generateKeyPair } from '@dsh-remote/crypto'
import {
  SecureMessageCodec,
  createRpcRequest,
  decodeMessage,
  encodeMessage,
} from '@dsh-remote/protocol'
import { HostServerApi, type SecureSettings } from './server-api'
import type { HostIdentity } from './host-ports'
export { HostServerApi }
export type { SecureSettings, HostIdentity }
export async function loadTransportIdentity(
  storage: SecureSettings,
  name: string,
): Promise<HostIdentity> {
  const saved = await storage.get('noise-identity-v1')
  if (saved) return JSON.parse(saved)
  const value = { deviceId: crypto.randomUUID(), name, ...generateKeyPair() }
  await storage.set('noise-identity-v1', JSON.stringify(value))
  return value
}
/** The same Noise channel runs over LAN/P2P, TURN, or Relay; no plaintext fallback. */
export class SecureMobileConnection {
  private transport?: AdaptiveTransport
  private noise?: NoiseIkSession
  private readonly incoming = new SecureMessageCodec()
  private readonly outgoing = new SecureMessageCodec()
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private sendTail = Promise.resolve()
  private epoch = 0
  constructor(
    readonly api: HostServerApi,
    readonly identity: HostIdentity,
    readonly rtcFactory?: RtcPeerConnectionFactory,
  ) {}
  async connect(hostDeviceId: string, forceRelay = false) {
    await this.close()
    const epoch = this.epoch
    const peer = await this.api.deviceFor(hostDeviceId)
    if (epoch !== this.epoch) throw new Error('STALE_CONNECTION')
    const pinKey = `host-pin:${this.api.baseUrl}:${hostDeviceId}`
    const pin = await this.api.storage.get(pinKey)
    if (pin && pin !== peer.identityKey) throw new Error('HOST_IDENTITY_CHANGED')
    if (!pin) await this.api.storage.set(pinKey, peer.identityKey)
    const tokens = await this.api.authenticate(this.identity)
    if (epoch !== this.epoch) throw new Error('STALE_CONNECTION')
    const url = new URL('/ws/v1/connect', this.api.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const transport = new AdaptiveTransport(url.href, {
      role: 'client',
      deviceId: this.identity.deviceId,
      accessToken: tokens.accessToken,
      refreshAccessToken: async () => (await this.api.refreshCredentials()).accessToken,
      targetDeviceId: hostDeviceId,
      rtcFactory: this.rtcFactory,
      forceRelay,
      fetchIceServers: (id) => this.api.turnCredentials(id),
      preferredTransports: ['lan', 'p2p', 'turn', 'relay'],
    })
    this.transport = transport
    transport.onClose((error) => {
      if (this.transport === transport) this.fail(error || new Error('TRANSPORT_CLOSED'))
    })
    try {
      await transport.connect()
    } catch (error) {
      await transport.close()
      if (this.transport === transport) this.transport = undefined
      throw error
    }
    if (epoch !== this.epoch) {
      await transport.close()
      throw new Error('STALE_CONNECTION')
    }
    const info = transport.connectionInfo()
    const noise = new NoiseIkSession({
      role: 'initiator',
      localPrivateKey: this.identity.privateKey,
      localPublicKey: this.identity.publicKey,
      remotePublicKey: peer.identityKey,
      prologue: createNoisePrologue(info.connectionId, hostDeviceId, this.identity.deviceId),
    })
    this.noise = noise
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SECURE_HANDSHAKE_TIMEOUT')), 15_000)
      const off = transport.onHandshake((step, data) => {
        try {
          if (epoch !== this.epoch) throw new Error('STALE_CONNECTION')
          if (step !== 2) throw new Error('INVALID_HANDSHAKE')
          noise.readHandshake(data)
          if (!noise.complete) throw new Error('INCOMPLETE_HANDSHAKE')
          clearTimeout(timer)
          off()
          transport.markSecureReady()
          resolve()
        } catch (error) {
          clearTimeout(timer)
          off()
          reject(error)
        }
      })
      void transport.sendHandshake(1, noise.writeHandshake()).catch((error) => {
        clearTimeout(timer)
        off()
        reject(error)
      })
    }).catch(async (error) => {
      if (this.transport === transport) await this.close()
      else await transport.close()
      throw error
    })
    transport.onMessage((bytes) => {
      if (this.transport !== transport) return
      try {
        const decoded = this.incoming.decode(noise.decrypt(bytes))
        if (!decoded) return
        const message = decodeMessage(decoded),
          payload = message.payload as { requestId: string; result?: unknown; code?: string }
        const pending = this.pending.get(payload.requestId)
        if (!pending) return
        this.pending.delete(payload.requestId)
        clearTimeout(pending.timer)
        if (message.type === 'rpc.response') pending.resolve(payload.result)
        else pending.reject(new Error(payload.code || 'REMOTE_ERROR'))
      } catch {
        this.fail(new Error('SECURE_CHANNEL_FAILED'))
        void this.close()
      }
    })
  }
  request(
    method: string,
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    if (!this.transport || !this.noise?.complete) return Promise.reject(new Error('NOT_CONNECTED'))
    const message = createRpcRequest('plugin.route.call', {
      plugin: 'bigdogoffice',
      method,
      path,
      data,
      headers,
    })
    const transport = this.transport,
      noise = this.noise
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(message.id)
          reject(new Error('RPC_TIMEOUT'))
        },
        path.endsWith('/rpc') &&
          (data as { method?: string } | undefined)?.method === 'artifacts.preview'
          ? 180_000
          : 30_000,
      )
      this.pending.set(message.id, { resolve, reject, timer })
    })
    this.sendTail = this.sendTail
      .then(async () => {
        if (!this.pending.has(message.id)) return
        for (const part of this.outgoing.encode(encodeMessage(message))) {
          if (this.transport !== transport) throw new Error('STALE_CONNECTION')
          await transport.send(noise.encrypt(part))
        }
      })
      .catch((error) => {
        if (this.transport === transport) this.fail(error)
      })
    return result
  }
  stats() {
    return this.transport?.getStats()
  }
  private fail(error: Error) {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
  }
  async close() {
    this.epoch++
    this.fail(new Error('TRANSPORT_CLOSED'))
    const transport = this.transport
    this.transport = undefined
    await transport?.close()
    this.noise?.destroy()
    this.noise = undefined
    this.incoming.reset()
    this.outgoing.reset()
    this.sendTail = Promise.resolve()
  }
}
