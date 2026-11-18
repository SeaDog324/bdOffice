/* global indexedDB */
let vault
export async function secureSettings() {
  if (globalThis.BigDogNative)
    return {
      get: async (key) => globalThis.BigDogNative.secureGet(key) || undefined,
      set: async (key, value) => {
        if (!globalThis.BigDogNative.secureSet(key, value)) throw new Error('VAULT_WRITE_FAILED')
      },
    }
  if (vault) return vault
  if (!globalThis.crypto?.subtle || typeof indexedDB === 'undefined')
    throw new Error('SECURE_IDENTITY_UNAVAILABLE')
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('bigdog-remote-vault', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('vault')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const read = (key) =>
    new Promise((resolve, reject) => {
      const q = db.transaction('vault').objectStore('vault').get(key)
      q.onsuccess = () => resolve(q.result)
      q.onerror = () => reject(q.error)
    })
  const write = (key, value) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction('vault', 'readwrite')
      tx.objectStore('vault').put(value, key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  let key = await read('key')
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])
    await write('key', key)
  }
  vault = {
    get: async (id) => {
      const value = await read('item:' + id)
      if (!value) return
      return new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: value.iv, additionalData: new TextEncoder().encode(id) },
          key,
          value.bytes,
        ),
      )
    },
    set: async (id, value) => {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const bytes = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) },
        key,
        new TextEncoder().encode(value),
      )
      await write('item:' + id, { iv, bytes })
    },
  }
  return vault
}
