import { createPublicKey, verify } from 'node:crypto'
import { accountDeviceDescriptorSchema } from '@dsh-remote/protocol'
import { z } from 'zod'
import { pairingProofPayload } from '../../../packages/remote-core/src/pairing.js'
import { ApiError, hash, secret, type Store } from './store.js'

const claimSchema = z
  .object({
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    device: accountDeviceDescriptorSchema,
    proof: z
      .object({
        publicKey: z.string().max(256),
        signature: z.string().max(256),
        encoding: z.enum(['der', 'ieee-p1363']),
      })
      .strict(),
  })
  .strict()
/** Short-lived capability, held only in memory. Account credentials never enter the invitation. */
export class PairingInvitations {
  private tickets = new Map<
    string,
    {
      host: string
      expiresAt: number
      claim?: { fingerprint: string; tokens: ReturnType<Store['register']> }
    }
  >()
  constructor(
    private store: Store,
    private origin: string,
    private now = Date.now,
  ) {}
  create(host: string) {
    if (this.store.get(host).descriptor.role !== 'host')
      throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    for (const [id, row] of this.tickets)
      if (row.expiresAt <= this.now() || row.host === host) this.tickets.delete(id)
    if (this.tickets.size >= 256) throw new ApiError('RATE_LIMITED', 429)
    const ticket = secret(),
      expiresAt = this.now() + 5 * 60_000
    this.tickets.set(hash(ticket), { host, expiresAt })
    return { ticket, expiresAt }
  }
  redeem(input: unknown) {
    const value = claimSchema.parse(input),
      row = this.tickets.get(hash(value.ticket))
    if (!row || row.expiresAt <= this.now()) throw new ApiError('PAIRING_EXPIRED', 410)
    const host = this.store.get(row.host).descriptor
    if (value.device.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    let valid = false
    try {
      const key = createPublicKey({
        key: Buffer.from(value.proof.publicKey, 'base64'),
        type: 'spki',
        format: 'der',
      })
      valid =
        key.asymmetricKeyType === 'ec' &&
        key.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
        verify(
          'sha256',
          Buffer.from(pairingProofPayload(this.origin, value.ticket, value.device)),
          { key, dsaEncoding: value.proof.encoding },
          Buffer.from(value.proof.signature, 'base64'),
        )
    } catch {}
    if (!valid) throw new ApiError('PAIRING_PROOF_INVALID', 403)
    const fingerprint = hash(
      JSON.stringify([value.device.deviceId, value.device.identityKey, value.proof.publicKey]),
    )
    if (row.claim) {
      if (row.claim.fingerprint !== fingerprint) throw new ApiError('PAIRING_USED', 409)
      this.store.authenticate(row.claim.tokens.accessToken)
      return { tokens: row.claim.tokens, host }
    }
    const tokens = this.store.register(value.device, row.host)
    row.claim = { fingerprint, tokens }
    return { tokens, host }
  }
}
