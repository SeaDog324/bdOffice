import {
  HostServerApi,
  SecureMobileConnection,
  loadTransportIdentity,
} from '@bigdogoffice/remote-core/transport'
import { secureSettings } from './secure-settings.mjs'
import { nativeRtcFactory } from './native-rtc.mjs'
import { sealOffline } from '@bigdogoffice/remote-core/offline'
import { pairingProofPayload } from '@bigdogoffice/remote-core/pairing'
export async function openPairingInvitation(invite, name, proofIdentity) {
  const settings = await secureSettings()
  const identity = await loadTransportIdentity(settings, name || '大狗手机')
  const api = new HostServerApi(invite.server, settings, 'client')
  const proof = await proofIdentity()
  const device = {
    deviceId: identity.deviceId,
    identityKey: identity.publicKey,
    name: identity.name,
  }
  const host = await api.redeemPairing(identity, invite.ticket, {
    publicKey: proof.publicKey,
    encoding: proof.encoding,
    signature: await proof.sign(pairingProofPayload(api.baseUrl, invite.ticket, device)),
  })
  if (host.deviceId !== invite.host || host.identityKey !== invite.key)
    throw new Error('HOST_IDENTITY_CHANGED')
  const pinKey = `host-pin:${api.baseUrl}:${invite.host}`
  const pin = await settings.get(pinKey)
  if (pin && pin !== invite.key) throw new Error('HOST_IDENTITY_CHANGED')
  await settings.set(pinKey, invite.key)
  return { api, identity, devices: [host] }
}
export async function openRemoteServer(url, account, password, name) {
  const settings = await secureSettings()
  const identity = await loadTransportIdentity(settings, name || '大狗手机')
  const api = new HostServerApi(url, settings, 'client')
  try {
    await api.authenticate(identity)
  } catch (error) {
    if (!account || !password) throw error
    await api.authorize(identity, account, password)
  }
  const result = await api.devices()
  const devices = Array.isArray(result) ? result : result.devices || result.items || []
  return { api, identity, devices }
}
export async function connectRemoteHost(server, id, forceRelay = false) {
  const connection = new SecureMobileConnection(server.api, server.identity, nativeRtcFactory())
  await connection.connect(id, forceRelay)
  return {
    base: `https://${id}.bigdog.invalid`,
    request: (options) =>
      connection.request(
        options.method || 'GET',
        new URL(options.url).pathname,
        options.data,
        options.header?.Authorization ? { Authorization: options.header.Authorization } : {},
      ),
    stats: () => connection.stats(),
    close: () => connection.close(),
  }
}
export async function enqueueRemote(server, hostDeviceId, sessionId, command, durable) {
  if (command.expiresAt <= Date.now()) throw new Error('OUTBOX_EXPIRED')
  let packet = durable.value.queue[command.requestId]?.envelope
  if (packet && durable.value.queue[command.requestId]?.serverOrigin !== server.api.baseUrl)
    throw new Error('OUTBOX_ORIGIN_UNKNOWN')
  if (!packet) {
    const owner = await server.api.courier('owner/' + sessionId)
    if (!owner || owner.host !== hostDeviceId || owner.state !== 'active')
      throw new Error('OWNER_CHANGED')
    const peer = await server.api.deviceFor(hostDeviceId)
    const pin = await server.api.storage.get(`host-pin:${server.api.baseUrl}:${hostDeviceId}`)
    if (!pin || pin !== peer.identityKey) throw new Error('HOST_IDENTITY_CHANGED')
    packet = sealOffline(
      server.identity,
      peer.identityKey,
      {
        version: 1,
        sender: server.identity.deviceId,
        target: hostDeviceId,
        sessionId,
        requestId: command.requestId,
        epoch: owner.epoch,
        expiresAt: command.expiresAt,
      },
      { text: command.text },
      server.api.baseUrl,
    )
    durable.value.queue[command.requestId].envelope = packet
    durable.value.queue[command.requestId].serverOrigin = server.api.baseUrl
    durable.save()
  }
  const receipt = await server.api.courier('enqueue', packet)
  const queued = durable.value.queue[command.requestId]
  if (queued) {
    queued.status = 'server-queued'
    durable.save()
  }
  return receipt
}
