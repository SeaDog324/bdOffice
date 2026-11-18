import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class RemoteIdentityError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export interface DeviceProof {
  publicKey: string
  challengeId: string
  signature: string
  encoding: 'der' | 'ieee-p1363'
}
interface Challenge {
  key: string
  purpose: 'pair' | 'resume'
  payload: string
  expiresAt: number
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** Durable identities contain public keys only. Connection tokens and challenges are ephemeral. */
export class RemoteIdentityStore {
  private readonly db: DatabaseSync
  private readonly challenges = new Map<string, Challenge>()
  readonly hostId: string
  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS remote_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_devices(id TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, revision INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_receipts(device_id TEXT NOT NULL, session_id TEXT NOT NULL,
        request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(device_id,session_id,request_id));
      CREATE TABLE IF NOT EXISTS remote_delivery(device_id TEXT NOT NULL, event_id TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL, PRIMARY KEY(device_id,event_id));
      CREATE TABLE IF NOT EXISTS remote_carriers(peer_id TEXT PRIMARY KEY,peer_key TEXT NOT NULL,device_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS courier_tasks(message_id INTEGER PRIMARY KEY,task_id TEXT NOT NULL,last_revision INTEGER NOT NULL DEFAULT -1);`)
    this.db.prepare('INSERT OR IGNORE INTO remote_meta VALUES(?,?)').run('hostId', randomUUID())
    this.hostId = String(
      this.db.prepare('SELECT value FROM remote_meta WHERE key=?').get('hostId')!.value,
    )
  }
  close() {
    this.challenges.clear()
    this.db.close()
  }
  private publicKey(encoded: unknown): string {
    try {
      if (
        typeof encoded !== 'string' ||
        encoded.length > 512 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      )
        throw 0
      const key = createPublicKey({
        key: Buffer.from(encoded, 'base64'),
        format: 'der',
        type: 'spki',
      })
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
        throw 0
      return key.export({ format: 'der', type: 'spki' }).toString('base64')
    } catch {
      throw new RemoteIdentityError('INVALID_DEVICE_KEY')
    }
  }
  challenge(publicKey: unknown, purpose: unknown) {
    const key = this.publicKey(publicKey)
    if (purpose !== 'pair' && purpose !== 'resume')
      throw new RemoteIdentityError('INVALID_CHALLENGE')
    for (const [id, challenge] of this.challenges)
      if (challenge.expiresAt <= this.now()) this.challenges.delete(id)
    if (this.challenges.size >= 256) throw new RemoteIdentityError('AUTH_RATE_LIMIT')
    const id = randomBytes(24).toString('hex'),
      expiresAt = this.now() + 60_000
    const payload = [
      'bigdog.mobile.auth.v1',
      this.hostId,
      sha(Buffer.from(key, 'base64')),
      purpose,
      id,
      expiresAt,
    ].join('\n')
    this.challenges.set(id, { key, purpose, payload, expiresAt })
    return { hostId: this.hostId, challengeId: id, payload, expiresAt }
  }
  authenticate(proof: DeviceProof, purpose: 'pair' | 'resume', name = '') {
    if (!proof || typeof proof.challengeId !== 'string')
      throw new RemoteIdentityError('DEVICE_PROOF_REQUIRED')
    const challenge = this.challenges.get(proof.challengeId)
    this.challenges.delete(proof.challengeId)
    const key = this.publicKey(proof.publicKey)
    if (
      !challenge ||
      challenge.expiresAt <= this.now() ||
      challenge.purpose !== purpose ||
      challenge.key !== key
    )
      throw new RemoteIdentityError('CHALLENGE_EXPIRED')
    if (
      !['der', 'ieee-p1363'].includes(proof.encoding) ||
      typeof proof.signature !== 'string' ||
      proof.signature.length > 200 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(proof.signature)
    )
      throw new RemoteIdentityError('INVALID_DEVICE_PROOF')
    const valid = verify(
      'sha256',
      Buffer.from(challenge.payload),
      {
        key: createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }),
        dsaEncoding: proof.encoding,
      },
      Buffer.from(proof.signature, 'base64'),
    )
    if (!valid) throw new RemoteIdentityError('INVALID_DEVICE_PROOF')
    const deviceId = sha(Buffer.from(key, 'base64'))
    const existing = this.db
      .prepare('SELECT revision,revoked FROM remote_devices WHERE id=?')
      .get(deviceId)
    if (purpose === 'resume' && (!existing || existing.revoked))
      throw new RemoteIdentityError('DEVICE_REVOKED')
    if (purpose === 'pair') {
      if (
        !existing &&
        Number(this.db.prepare('SELECT count(*) AS n FROM remote_devices').get()!.n) >= 128
      )
        throw new RemoteIdentityError('DEVICE_LIMIT')
      this.db
        .prepare(
          `INSERT INTO remote_devices VALUES(?,?,?,1,0,?,?) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,revoked=0,revision=remote_devices.revision+1,last_seen=excluded.last_seen`,
        )
        .run(deviceId, key, name, this.now(), this.now())
    } else
      this.db.prepare('UPDATE remote_devices SET last_seen=? WHERE id=?').run(this.now(), deviceId)
    return { deviceId, revision: this.revision(deviceId)! }
  }
  revision(deviceId: string): number | undefined {
    const row = this.db
      .prepare('SELECT revision FROM remote_devices WHERE id=? AND revoked=0')
      .get(deviceId)
    return row ? Number(row.revision) : undefined
  }
  list() {
    return this.db
      .prepare(
        'SELECT id,name,revision,revoked,created_at AS createdAt,last_seen AS lastSeen FROM remote_devices ORDER BY last_seen DESC',
      )
      .all()
  }
  revoke(deviceId: string) {
    this.db
      .prepare('UPDATE remote_devices SET revoked=1,revision=revision+1 WHERE id=?')
      .run(deviceId)
  }
  receipt(device: string, session: string, request: string, text?: string) {
    const row = this.db
      .prepare(
        'SELECT task_id,payload_hash FROM remote_receipts WHERE device_id=? AND session_id=? AND request_id=?',
      )
      .get(device, session, request)
    if (!row) return null
    if (text !== undefined && row.payload_hash !== sha(text))
      throw new RemoteIdentityError('REQUEST_CONFLICT')
    return { taskId: String(row.task_id), duplicate: true }
  }
  record(device: string, session: string, request: string, text: string, task: string) {
    this.receipt(device, session, request, text)
    this.db
      .prepare('INSERT OR IGNORE INTO remote_receipts VALUES(?,?,?,?,?,?)')
      .run(device, session, request, sha(text), task, this.now())
  }
  acknowledge(device: string, event: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO remote_delivery VALUES(?,?,?)')
      .run(device, event, this.now())
  }
  acknowledged(device: string, event: string) {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM remote_delivery WHERE device_id=? AND event_id=?')
        .get(device, event),
    )
  }
  bindCarrier(peer: string, publicKey: string, device: string) {
    if (this.revision(device) === undefined) throw new RemoteIdentityError('DEVICE_REVOKED')
    const old = this.db
      .prepare('SELECT peer_key,device_id FROM remote_carriers WHERE peer_id=?')
      .get(peer)
    if (old && (old.peer_key !== publicKey || old.device_id !== device))
      throw new RemoteIdentityError('PEER_IDENTITY_MISMATCH')
    this.db
      .prepare('INSERT OR IGNORE INTO remote_carriers VALUES(?,?,?)')
      .run(peer, publicKey, device)
  }
  carrierDevice(peer: string, publicKey: string) {
    const value = this.db
      .prepare('SELECT device_id FROM remote_carriers WHERE peer_id=? AND peer_key=?')
      .get(peer, publicKey)
    if (!value || this.revision(String(value.device_id)) === undefined)
      throw new RemoteIdentityError('DEVICE_REVOKED')
    return String(value.device_id)
  }
  courierTask(message: number, taskId: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO courier_tasks(message_id,task_id) VALUES(?,?)')
      .run(message, taskId)
  }
  courierTasks() {
    return this.db
      .prepare(
        'SELECT message_id AS messageId,task_id AS taskId,last_revision AS revision FROM courier_tasks',
      )
      .all()
  }
  courierRevision(message: number, revision: number) {
    this.db
      .prepare('UPDATE courier_tasks SET last_revision=? WHERE message_id=?')
      .run(revision, message)
  }
  forgetCourierTask(message: number) {
    this.db.prepare('DELETE FROM courier_tasks WHERE message_id=?').run(message)
  }
}
