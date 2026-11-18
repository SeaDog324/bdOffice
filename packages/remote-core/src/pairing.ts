/** Self-contained invitation. Never include account passwords or durable device credentials. */
export interface PairingInvitation {
  v: 1
  server: string
  host: string
  name: string
  key: string
  code: string
  ticket: string
  expires: number
}
export function pairingServer(value: string): string {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname)))
  )
    throw new Error('INVALID_SERVER')
  return url.origin
}
function validate(value: unknown, now: number): PairingInvitation {
  const v = value as PairingInvitation
  if (
    !v ||
    v.v !== 1 ||
    typeof v.server !== 'string' ||
    v.server.length > 256 ||
    typeof v.host !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(v.host) ||
    typeof v.name !== 'string' ||
    !v.name.trim() ||
    v.name.length > 80 ||
    typeof v.key !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.key) ||
    typeof v.code !== 'string' ||
    !/^[a-f0-9]{12}$/.test(v.code) ||
    typeof v.ticket !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.ticket) ||
    !Number.isSafeInteger(v.expires) ||
    v.expires > now + 10 * 60_000
  )
    throw new Error('INVALID_PAIRING_INVITATION')
  if (v.expires <= now) throw new Error('PAIRING_EXPIRED')
  return {
    v: 1,
    server: pairingServer(v.server),
    host: v.host,
    name: v.name.trim(),
    key: v.key,
    code: v.code,
    ticket: v.ticket,
    expires: v.expires,
  }
}
export function encodePairingInvitation(value: PairingInvitation, now = Date.now()): string {
  const bytes = new TextEncoder().encode(JSON.stringify(validate(value, now)))
  return (
    'bigdog-pair:v1:' +
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  )
}
export function parsePairingInvitation(text: string, now = Date.now()): PairingInvitation {
  const source = text.trim()
  if (source.length > 2048 || !/^bigdog-pair:v1:[A-Za-z0-9_-]+$/.test(source))
    throw new Error('INVALID_PAIRING_INVITATION')
  let value: unknown
  try {
    const encoded = source.slice('bigdog-pair:v1:'.length).replace(/-/g, '+').replace(/_/g, '/')
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
      ),
    )
  } catch {
    throw new Error('INVALID_PAIRING_INVITATION')
  }
  return validate(value, now)
}
export function pairingProofPayload(
  origin: string,
  ticket: string,
  device: { deviceId: string; identityKey: string; name: string },
) {
  return (
    'bigdog.mobile.auth.v1\n' +
    JSON.stringify([
      'remote-pair-v1',
      origin,
      ticket,
      device.deviceId,
      device.identityKey,
      device.name,
    ])
  )
}
