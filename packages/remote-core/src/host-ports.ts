import type { RemoteMessage } from '@dsh-remote/protocol'
export const PLUGIN_VERSION = 'bigdog-0.1.0'
export interface HostIdentity {
  deviceId: string
  name: string
  publicKey: string
  privateKey: string
}
export interface TrustedPeer {
  deviceId: string
  name: string
  platform: string
  publicKey: string
  membershipId?: string
  trustedAt?: number
  fingerprint?: string
}
export interface IdentityStore {
  trustedPeer(id: string): TrustedPeer | undefined
  trustPeer(peer: TrustedPeer): Promise<TrustedPeer>
}
export interface ResolvedConfig {
  forceRelay: boolean
  rotatePinnedPeerKey: boolean
  reconnect: { enabled: boolean; maxDelayMs: number }
}
export interface SafeLogger {
  debug(message: string, fields?: unknown): void
  info(message: string, fields?: unknown): void
  warn(message: string, fields?: unknown): void
  error(message: string, fields?: unknown): void
}
export interface ConnectionCloseDetail {
  [key: string]: unknown
}
export interface PeerChannel {
  security: { protocol: string; connectionId: string; membershipId: string }
  peerDeviceId: string
  peerIdentityKey: string
  mode?: string
  send(message: RemoteMessage): Promise<void>
  onMessage(callback: (message: RemoteMessage) => void): () => void
  close(code?: string): Promise<void>
}
export interface ConnectionController {
  accept(channel: PeerChannel): Promise<void>
  close(): Promise<void>
  closeConnection(id: string, code?: string, detail?: ConnectionCloseDetail): Promise<boolean>
}
