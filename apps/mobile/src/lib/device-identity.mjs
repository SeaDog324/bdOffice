/* global plus, indexedDB */
const alias = 'bigdog.mobile.identity.v1'
const b64 = (bytes) => {
  let value = ''
  for (const byte of new Uint8Array(bytes)) value += String.fromCharCode(byte)
  return btoa(value)
}
let pending
export function deviceIdentity() {
  pending ??= loadIdentity().catch((error) => {
    pending = undefined
    throw error
  })
  return pending
}
async function loadIdentity() {
  if (globalThis.BigDogNative) {
    return {
      publicKey: globalThis.BigDogNative.identity(),
      encoding: 'der',
      sign: async (text) => globalThis.BigDogNative.sign(text),
    }
  }
  if (typeof plus !== 'undefined' && plus.android) {
    const KeyStore = plus.android.importClass('java.security.KeyStore')
    const Base64 = plus.android.importClass('android.util.Base64')
    const Signature = plus.android.importClass('java.security.Signature')
    const store = KeyStore.getInstance('AndroidKeyStore')
    plus.android.importClass(store)
    store.load(null)
    if (!store.containsAlias(alias)) {
      const Generator = plus.android.importClass('java.security.KeyPairGenerator')
      const Builder = plus.android.importClass(
        'android.security.keystore.KeyGenParameterSpec$Builder',
      )
      const Curve = plus.android.importClass('java.security.spec.ECGenParameterSpec')
      const generator = Generator.getInstance('EC', 'AndroidKeyStore')
      plus.android.importClass(generator)
      const spec = new Builder(alias, 12)
        .setDigests(['SHA-256'])
        .setAlgorithmParameterSpec(new Curve('secp256r1'))
        .build()
      generator.initialize(spec)
      generator.generateKeyPair()
    }
    const certificate = store.getCertificate(alias)
    plus.android.importClass(certificate)
    const publicKey = certificate.getPublicKey()
    plus.android.importClass(publicKey)
    return {
      publicKey: Base64.encodeToString(publicKey.getEncoded(), 2),
      encoding: 'der',
      sign: async (text) => {
        const signer = Signature.getInstance('SHA256withECDSA')
        plus.android.importClass(signer)
        signer.initSign(store.getKey(alias, null))
        const JString = plus.android.importClass('java.lang.String')
        signer.update(new JString(text).getBytes('UTF-8'))
        return Base64.encodeToString(signer.sign(), 2)
      },
    }
  }
  if (!globalThis.crypto?.subtle || typeof indexedDB === 'undefined')
    throw new Error('SECURE_IDENTITY_UNAVAILABLE')
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('bigdog-device', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('keys')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const read = () =>
    new Promise((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get(alias)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  let pair = await read()
  if (!pair) {
    const generated = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    // Recheck in the write transaction so simultaneous tabs cannot replace one another's identity.
    pair = await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite'),
        store = tx.objectStore('keys'),
        request = store.get(alias)
      let selected
      request.onsuccess = () => {
        selected = request.result || generated
        if (!request.result) store.put(selected, alias)
      }
      tx.oncomplete = () => resolve(selected)
      tx.onerror = () => reject(tx.error)
    })
  }
  db.close()
  return {
    publicKey: b64(await crypto.subtle.exportKey('spki', pair.publicKey)),
    encoding: 'ieee-p1363',
    sign: async (text) =>
      b64(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          new TextEncoder().encode(text),
        ),
      ),
  }
}
