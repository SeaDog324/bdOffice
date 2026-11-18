let pending,
  serial = 0
export function scanPairing(mode = 'camera') {
  if (pending) return Promise.reject(new Error('PAIRING_SCAN_BUSY'))
  if (globalThis.BigDogNative?.scanQr) {
    return new Promise((resolve, reject) => {
      const id = `qr-${++serial}`
      pending = { id, resolve, reject }
      globalThis.__bigdogQr = (result) => {
        if (!pending || result.id !== pending.id) return
        const request = pending
        pending = undefined
        if (result.error) request.reject(new Error(result.error))
        else request.resolve(result.value)
      }
      globalThis.BigDogNative.scanQr(id, mode)
    })
  }
  return Promise.reject(new Error('PAIRING_SCAN_UNAVAILABLE'))
}
