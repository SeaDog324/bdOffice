/** Development-only loopback protocol. It is not the production encrypted Remote transport. */
export const MOBILE_HOST_PROTOCOL = 'bigdog.mobile-dev.v1'
export const MOBILE_HOST_DEFAULT_PORT = 48219
export interface RemoteAdminStatus {
  enabled: boolean
  online: boolean
  serverUrl?: string
  name?: string
  invitationState?: 'ready' | 'used' | 'expired'
  devices: Array<{ id: string; name: string; revoked: boolean; lastSeen: number }>
}
export interface RemoteAdminApi {
  status(): Promise<RemoteAdminStatus>
  invite(): Promise<{ code: string; expiresAt: number; qrDataUrl?: string }>
  saveQr(): Promise<boolean>
  revoke(deviceId: string): Promise<void>
}
export const REMOTE_ADMIN_CHANNELS = {
  status: 'remote-admin:status',
  invite: 'remote-admin:invite',
  saveQr: 'remote-admin:save-qr',
  revoke: 'remote-admin:revoke',
} as const
declare global {
  interface Window {
    aiOfficeRemote: RemoteAdminApi
  }
}
export interface MobilePairReply {
  token: string
  deviceId: string
  expiresAt: number
}
export interface MobileMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string | null
}
export interface MobileArtifact {
  id: string
  name: string
  mime: string
  bytes: number
  digest: string
}
export interface MobileRpcEnvelope {
  version: 1
  id: string
  method: string
  params?: Record<string, unknown>
}
export type MobileRpcReply =
  | { version: 1; id: string; ok: true; value: unknown }
  | { version: 1; id: string; ok: false; error: { code: string; message: string } }
