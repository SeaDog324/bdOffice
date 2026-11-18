import { decryptFrame, deriveSharedKey, encryptFrame } from '@dsh-remote/crypto'
import type { HostIdentity } from './host-ports'
export interface OfflineHeader {
  version: 1
  sender: string
  target: string
  sessionId: string
  requestId: string
  epoch: number
  expiresAt: number
}
export interface OfflineEnvelope extends OfflineHeader {
  nonce: string
  ciphertext: string
}
export function offlineAad(value: OfflineHeader) {
  return JSON.stringify([
    'bigdog.offline.v1',
    value.sender,
    value.target,
    value.sessionId,
    value.requestId,
    value.epoch,
    value.expiresAt,
  ])
}
export function sealOffline(
  identity: HostIdentity,
  targetPublicKey: string,
  header: OfflineHeader,
  command: unknown,
  audience: string,
): OfflineEnvelope {
  if (header.sender !== identity.deviceId || header.expiresAt <= Date.now())
    throw new Error('INVALID_OFFLINE_COMMAND')
  const key = deriveSharedKey(
    identity.privateKey,
    targetPublicKey,
    'bigdog.offline.v1:' + new URL(audience).origin,
  )
  return {
    ...header,
    ...encryptFrame(key, new TextEncoder().encode(JSON.stringify(command)), offlineAad(header)),
  }
}
export function openOffline(
  identity: HostIdentity,
  senderPublicKey: string,
  envelope: OfflineEnvelope,
  audience: string,
): unknown {
  if (
    envelope.version !== 1 ||
    envelope.target !== identity.deviceId ||
    envelope.expiresAt <= Date.now() ||
    envelope.ciphertext.length > 192 * 1024
  )
    throw new Error('COMMAND_EXPIRED')
  const key = deriveSharedKey(
    identity.privateKey,
    senderPublicKey,
    'bigdog.offline.v1:' + new URL(audience).origin,
  )
  return JSON.parse(new TextDecoder().decode(decryptFrame(key, envelope, offlineAad(envelope))))
}
