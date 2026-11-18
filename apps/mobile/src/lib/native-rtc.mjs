let serial = 0
const requests = new Map(),
  targets = new Map()
function call(method, target = '', args = {}) {
  const requestId = `rtc-${++serial}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(requestId)
      reject(new Error('NATIVE_RTC_TIMEOUT'))
    }, 12000)
    requests.set(requestId, { resolve, reject, timer })
    globalThis.BigDogNative.rtc(JSON.stringify({ requestId, target, method, args }))
  })
}
function install() {
  globalThis.__bigdogRtc = (event) => {
    if (event.requestId) {
      const request = requests.get(event.requestId)
      if (!request) return
      requests.delete(event.requestId)
      clearTimeout(request.timer)
      if (event.error) request.reject(new Error(event.error))
      else request.resolve(event.value)
    } else targets.get(event.target)?.event(event.type, event.value)
  }
}
const base64 = (bytes) => {
  let text = ''
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text)
}
class Channel {
  bufferedAmount = 0
  bufferedAmountLowThreshold = 65536
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  constructor(ready) {
    this.ready = ready.then((value) => {
      this.id = value.id
      this.label = value.label
      this.readyState = value.state
      targets.set(value.id, this)
      if (this.readyState === 'open') this.onopen?.()
      return value.id
    })
    this.ready.catch((error) => this.onerror?.(error))
  }
  event(type, value) {
    if (type === 'state') {
      this.readyState = value
      if (value === 'open') this.onopen?.()
      if (value === 'closed') this.onclose?.()
    }
    if (type === 'buffered') {
      this.bufferedAmount = value
      if (value < this.bufferedAmountLowThreshold) this.onbufferedamountlow?.()
    }
    if (type === 'message')
      this.onmessage?.({ data: Uint8Array.from(atob(value), (c) => c.charCodeAt(0)).buffer })
  }
  send(bytes) {
    if (this.readyState !== 'open') throw new Error('RTC_NOT_OPEN')
    const data = base64(bytes)
    this.bufferedAmount += bytes.byteLength
    void call('send', this.id, { data }).then(
      (amount) => {
        this.bufferedAmount = amount
        if (amount < this.bufferedAmountLowThreshold) this.onbufferedamountlow?.()
      },
      (error) => this.onerror?.(error),
    )
  }
  close() {
    this.readyState = 'closed'
    void this.ready
      .then((id) => {
        targets.delete(id)
        return call('closeChannel', id)
      })
      .catch(() => {})
  }
}
class Peer {
  connectionState = 'new'
  iceConnectionState = 'new'
  iceGatheringState = 'new'
  localDescription = null
  remoteDescription = null
  constructor(config) {
    this.ready = call('create', '', config).then((id) => {
      this.id = id
      targets.set(id, this)
      return id
    })
    this.channels = []
  }
  async invoke(method, args = {}) {
    return call(method, await this.ready, args)
  }
  event(type, value) {
    if (type === 'icecandidate') this.onicecandidate?.({ candidate: value })
    else if (type === 'datachannel') {
      const channel = new Channel(Promise.resolve(value))
      this.channels.push(channel)
      this.ondatachannel?.({ channel })
    } else {
      this[type] = value
      this[`on${type.toLowerCase()}change`]?.()
    }
  }
  createDataChannel(label) {
    const channel = new Channel(this.invoke('channel', { label }))
    this.channels.push(channel)
    return channel
  }
  createOffer() {
    return this.invoke('offer')
  }
  createAnswer() {
    return this.invoke('answer')
  }
  async setLocalDescription(value) {
    await this.invoke('local', value)
    this.localDescription = value
  }
  async setRemoteDescription(value) {
    await this.invoke('remote', value)
    this.remoteDescription = value
  }
  addIceCandidate(value) {
    return this.invoke('candidate', value || {})
  }
  async getStats() {
    const rows = await this.invoke('stats')
    return new Map(rows.map((row) => [row.id, row]))
  }
  close() {
    this.channels.forEach((channel) => channel.close())
    this.connectionState = 'closed'
    void this.ready
      .then((id) => {
        targets.delete(id)
        return call('close', id)
      })
      .catch(() => {})
  }
}
export function nativeRtcFactory() {
  if (!globalThis.BigDogNative?.rtc) return undefined
  install()
  return { create: (config) => new Peer(config) }
}
