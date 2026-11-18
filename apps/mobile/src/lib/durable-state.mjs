/* global uni */
/** One synchronous durable write precedes any command transmission. Storage failure stops the send. */
export class DurableState {
  constructor(storage, key = 'bigdog.mobile.state.v2') {
    this.storage = storage
    this.key = key
    const raw = storage.get(key)
    this.value = raw
      ? JSON.parse(raw)
      : { version: 2, hosts: {}, drafts: {}, pending: {}, notices: {} }
    if (this.value.version !== 2 || !this.value.hosts || !this.value.pending || !this.value.drafts)
      throw new Error('LOCAL_STATE_INVALID')
    this.value.queue ??= Object.fromEntries(
      Object.entries(this.value.pending).map(([key, command]) => [
        command.requestId,
        { key, ...command },
      ]),
    )
    this.value.catalogs ??= {}
    this.value.history ??= {}
    this.value.receipts ??= {}
    const connection = this.value.connection
    for (const command of Object.values(this.value.queue)) {
      if (
        command.envelope &&
        !command.serverOrigin &&
        connection?.remoteMode &&
        connection.chosenRemote === command.envelope.target &&
        connection.serverAddress
      ) {
        try {
          command.serverOrigin = new URL(connection.serverAddress).origin
        } catch {}
      }
    }
  }
  save() {
    // Read caches are disposable. Drafts, pending commands and receipts are not.
    let encoded = JSON.stringify(this.value)
    for (const section of ['history', 'catalogs']) {
      for (const key of Object.keys(this.value[section] || {})) {
        if (encoded.length < 3 * 1024 * 1024) break
        delete this.value[section][key]
        encoded = JSON.stringify(this.value)
      }
    }
    this.storage.set(this.key, encoded)
  }
  host(address) {
    return this.value.hosts[address]
  }
  remember(address, identity) {
    const existing = this.host(address)
    if (existing && existing.hostId !== identity.hostId) throw new Error('HOST_IDENTITY_CHANGED')
    this.value.hosts[address] = identity
    this.save()
  }
  list() {
    return Object.values(this.value.queue)
  }
}
export function mobileStorage() {
  if (globalThis.BigDogNative)
    return {
      get: (key) => globalThis.BigDogNative.secureGet(key),
      set: (key, value) => {
        if (!globalThis.BigDogNative.secureSet(key, value)) throw new Error('VAULT_WRITE_FAILED')
      },
    }
  return {
    get: (key) => uni.getStorageSync(key) || '',
    set: (key, value) => uni.setStorageSync(key, value),
  }
}
