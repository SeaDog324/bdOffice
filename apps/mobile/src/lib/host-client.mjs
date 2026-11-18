import { newRequestId, normalizeHost } from './state.mjs'
/* global uni */

export class HostError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}
/** Credentials live only in this client instance. Never put them in URLs, logs or persistent storage. */
export class HostClient {
  epoch = 0
  base = ''
  token = ''
  deviceId = ''
  expiresAt = 0
  constructor(request, identity, durable) {
    this.request = request
    this.identity = identity
    this.durable = durable
  }
  disconnect() {
    this.epoch++
    this.token = ''
    this.deviceId = ''
    this.expiresAt = 0
  }
  async pair(address, code, deviceName) {
    this.disconnect()
    this.base = normalizeHost(address)
    const epoch = this.epoch
    let proof
    if (this.identity) proof = await this.createProof('pair')
    if (epoch !== this.epoch) throw new HostError('STALE_CONNECTION')
    const response = await this.fetch(
      '/pair',
      {
        method: 'POST',
        data: {
          code: String(code).trim(),
          deviceName: String(deviceName || '大狗移动端').slice(0, 80),
          ...(proof ? { proof } : {}),
        },
      },
      false,
    )
    if (epoch !== this.epoch) throw new HostError('STALE_CONNECTION')
    const expiresAt =
      typeof response.expiresAt === 'number' ? response.expiresAt : Date.parse(response.expiresAt)
    if (
      typeof response.token !== 'string' ||
      response.token.length < 16 ||
      /[\r\n]/.test(response.token) ||
      typeof response.deviceId !== 'string' ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new HostError('PAIRING_FAILED')
    this.token = response.token
    this.deviceId = response.deviceId
    this.expiresAt = expiresAt
    this.hostId = response.hostId || this.base
    if (this.durable && response.hostId)
      this.durable.remember(this.base, { hostId: response.hostId, deviceId: this.deviceId })
    return { deviceId: this.deviceId, expiresAt }
  }
  async createProof(purpose) {
    const epoch = this.epoch
    const identity = await this.identity()
    if (epoch !== this.epoch) throw new HostError('STALE_CONNECTION')
    const challenge = await this.fetch(
      '/challenge',
      { method: 'POST', data: { publicKey: identity.publicKey, purpose } },
      false,
    )
    const pinned = this.durable?.host(this.base)
    if (pinned && pinned.hostId !== challenge.hostId) throw new HostError('HOST_IDENTITY_CHANGED')
    if (
      typeof challenge.payload !== 'string' ||
      challenge.payload.length > 2048 ||
      challenge.expiresAt <= Date.now()
    )
      throw new HostError('CHALLENGE_EXPIRED')
    const fields = challenge.payload.split('\n')
    if (
      fields.length !== 6 ||
      fields[0] !== 'bigdog.mobile.auth.v1' ||
      fields[1] !== challenge.hostId ||
      fields[3] !== purpose ||
      fields[4] !== challenge.challengeId ||
      Number(fields[5]) !== challenge.expiresAt
    )
      throw new HostError('INVALID_DEVICE_PROOF')
    return {
      publicKey: identity.publicKey,
      challengeId: challenge.challengeId,
      signature: await identity.sign(challenge.payload),
      encoding: identity.encoding,
    }
  }
  async resume(address) {
    this.disconnect()
    this.base = normalizeHost(address)
    const epoch = this.epoch,
      proof = await this.createProof('resume')
    if (epoch !== this.epoch) throw new HostError('STALE_CONNECTION')
    const response = await this.fetch('/resume', { method: 'POST', data: { proof } }, false)
    if (epoch !== this.epoch) throw new HostError('STALE_CONNECTION')
    if (
      typeof response.token !== 'string' ||
      response.expiresAt <= Date.now() ||
      !response.hostId ||
      !response.deviceId
    )
      throw new HostError('PAIRING_FAILED')
    this.durable?.remember(this.base, { hostId: response.hostId, deviceId: response.deviceId })
    this.token = response.token
    this.expiresAt = response.expiresAt
    this.deviceId = response.deviceId
    this.hostId = response.hostId
  }
  authorization() {
    if (!this.token || this.expiresAt <= Date.now()) throw new HostError('NOT_CONNECTED')
    return { Authorization: `Bearer ${this.token}` }
  }
  async fetch(path, options = {}, authorized = true) {
    const epoch = this.epoch
    let response
    try {
      response = await this.request({
        url: `${this.base}/mobile/v1${path}`,
        timeout: 12000,
        ...options,
        header: { 'Content-Type': 'application/json', ...(authorized ? this.authorization() : {}) },
      })
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError('NETWORK_ERROR')
    }
    if (epoch !== this.epoch) throw new HostError('STALE_CONNECTION')
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new HostError(
        response.data?.error?.code ||
          (response.statusCode === 401
            ? 'UNAUTHORIZED'
            : response.statusCode === 429
              ? 'RATE_LIMITED'
              : 'NETWORK_ERROR'),
      )
    }
    return response.data
  }
  async rpc(method, params = {}) {
    if (this.identity && this.expiresAt && this.expiresAt <= Date.now() + 30000) await this.renew()
    const id = newRequestId()
    const options = {
      method: 'POST',
      timeout: method === 'artifacts.preview' ? 180000 : 12000,
      data: { version: 1, id, method, params },
    }
    let reply
    try {
      reply = await this.fetch('/rpc', options)
    } catch (error) {
      if (!this.identity || error?.code !== 'UNAUTHORIZED') throw error
      await this.renew()
      reply = await this.fetch('/rpc', options)
    }
    if (!reply || reply.version !== 1 || reply.id !== id || typeof reply.ok !== 'boolean')
      throw new HostError('INVALID_RESPONSE')
    if (!reply.ok) throw new HostError(reply.error?.code || 'COMMAND_REJECTED')
    return reply.value
  }
  async renew() {
    if (this.renewing) return this.renewing
    this.renewing = this.resume(this.base).finally(() => {
      this.renewing = undefined
    })
    return this.renewing
  }
  artifactUrl(sessionId, artifactId) {
    if (!/^[0-9a-f-]{20,64}$/i.test(sessionId) || !/^[a-f0-9]{64}$/i.test(artifactId))
      throw new HostError('INVALID_ARTIFACT')
    return `${this.base}/mobile/v1/artifacts/${encodeURIComponent(sessionId)}/${encodeURIComponent(artifactId)}`
  }
  async readArtifact(sessionId, artifact) {
    if (artifact.bytes > 24 * 1024 * 1024) throw new HostError('FILE_TOO_LARGE')
    const chunks = []
    let offset = 0
    while (offset < artifact.bytes) {
      const part = await this.rpc('artifacts.read', { sessionId, artifactId: artifact.id, offset })
      if (
        part.digest !== artifact.digest ||
        part.bytes !== artifact.bytes ||
        part.nextOffset <= offset ||
        part.nextOffset > artifact.bytes
      )
        throw new HostError('INVALID_ARTIFACT')
      const decoded = Uint8Array.from(atob(part.base64), (c) => c.charCodeAt(0))
      if (decoded.length !== part.nextOffset - offset) throw new HostError('INVALID_ARTIFACT')
      chunks.push(decoded)
      offset = part.nextOffset
    }
    const bytes = new Uint8Array(offset)
    let cursor = 0
    for (const chunk of chunks) {
      bytes.set(chunk, cursor)
      cursor += chunk.length
    }
    if (globalThis.crypto?.subtle) {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      let hex = ''
      for (const value of hash) hex += value.toString(16).padStart(2, '0')
      if (hex !== artifact.digest) throw new HostError('INVALID_ARTIFACT')
    }
    return bytes
  }
}

export function uniRequest(options) {
  if (globalThis.BigDogNative?.network)
    return fetch(options.url, {
      method: options.method,
      headers: options.header,
      ...(options.data === undefined ? {} : { body: JSON.stringify(options.data) }),
    }).then(async (response) => ({
      statusCode: response.status,
      data: options.dataType === 'text' ? await response.text() : await response.json(),
    }))
  return new Promise((resolve, reject) =>
    uni.request({ ...options, success: resolve, fail: reject }),
  )
}
