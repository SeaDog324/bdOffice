const pending = new Map(),
  sockets = new Map()
let serial = 0
export function installNativeNetwork() {
  if (!globalThis.BigDogNative?.network || globalThis.__bigdogNetwork) return
  const native = globalThis.BigDogNative
  globalThis.__bigdogNetwork = (event) => {
    if (event.type === 'http' || (event.type === 'error' && pending.has(event.id))) {
      const request = pending.get(event.id)
      if (!request) return
      pending.delete(event.id)
      clearTimeout(request.timer)
      if (event.type === 'error') request.reject(new Error(event.value))
      else request.resolve(new Response(event.value.body, { status: event.value.status }))
      return
    }
    const socket = sockets.get(event.id)
    if (!socket) return
    if (event.type === 'open') socket.readyState = 1
    if (event.type === 'close') {
      socket.readyState = 3
      sockets.delete(event.id)
    }
    const message =
      event.type === 'message' ? { data: event.value } : event.type === 'close' ? event.value : {}
    socket['on' + event.type]?.(message)
    for (const handler of socket.handlers.get(event.type) || []) handler(message)
  }
  globalThis.fetch = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const id = `http-${++serial}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('NETWORK_TIMEOUT'))
      }, 180000)
      pending.set(id, { resolve, reject, timer })
      options.signal?.addEventListener(
        'abort',
        () => {
          if (!pending.has(id)) return
          pending.delete(id)
          clearTimeout(timer)
          reject(new Error('ABORTED'))
        },
        { once: true },
      )
      const headers = Object.fromEntries(new Headers(options.headers).entries())
      native.network(
        JSON.stringify({
          id,
          method: 'http',
          url: String(url),
          verb: options.method || 'GET',
          headers,
          body: options.body || '',
        }),
      )
    })
  class NativeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    CONNECTING = 0
    OPEN = 1
    CLOSING = 2
    CLOSED = 3
    readyState = 0
    bufferedAmount = 0
    binaryType = 'arraybuffer'
    handlers = new Map()
    constructor(url) {
      this.id = `ws-${++serial}`
      this.url = url
      sockets.set(this.id, this)
      native.network(JSON.stringify({ id: this.id, method: 'ws-open', url }))
    }
    send(data) {
      if (this.readyState !== 1 || typeof data !== 'string') throw new Error('SOCKET_NOT_OPEN')
      native.network(JSON.stringify({ id: this.id, method: 'ws-send', data }))
    }
    close(code = 1000, reason = '') {
      this.readyState = 2
      native.network(JSON.stringify({ id: this.id, method: 'ws-close', code, reason }))
    }
    addEventListener(type, fn) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set())
      this.handlers.get(type).add(fn)
    }
    removeEventListener(type, fn) {
      this.handlers.get(type)?.delete(fn)
    }
  }
  globalThis.WebSocket = NativeWebSocket
}
