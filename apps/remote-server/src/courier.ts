import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { ApiError, type Store } from './store.js'

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
export const envelopeSchema = z
  .object({
    version: z.literal(1),
    sender: identifier,
    target: identifier,
    sessionId: identifier,
    requestId: identifier,
    epoch: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(192 * 1024),
  })
  .strict()
type Actor = ReturnType<Store['get']>['descriptor']
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Durable opaque inbox, per-device delivery receipts and fenced Session ownership. */
export class Courier {
  readonly db: DatabaseSync
  constructor(
    path: string,
    private readonly devices: Store,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,sender TEXT NOT NULL,target TEXT NOT NULL,
        session_id TEXT NOT NULL,request_id TEXT NOT NULL,epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',task_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,acknowledged INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
        UNIQUE(sender,target,session_id,request_id));
      CREATE TABLE IF NOT EXISTS owners(session_id TEXT PRIMARY KEY,host TEXT NOT NULL,epoch INTEGER NOT NULL,
        lease_until INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'active',ticket TEXT,target TEXT,digest TEXT,target_session TEXT);
      CREATE TABLE IF NOT EXISTS push_devices(device TEXT PRIMARY KEY,endpoint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_jobs(device TEXT PRIMARY KEY,due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);`)
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS handoffs(ticket TEXT PRIMARY KEY,source TEXT NOT NULL,target TEXT NOT NULL,
      root TEXT NOT NULL,digest TEXT NOT NULL,scope TEXT NOT NULL,targets TEXT,state TEXT NOT NULL DEFAULT 'prepared');`)
  }
  close() {
    this.db.close()
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  owner(sessionId: string) {
    return this.db
      .prepare(
        'SELECT session_id AS sessionId,host,epoch,lease_until AS leaseUntil,state,target,target_session AS targetSession FROM owners WHERE session_id=? OR target_session=?',
      )
      .get(sessionId, sessionId)
  }
  lease(actor: Actor, input: unknown) {
    const value = z
      .object({ sessionId: identifier, epoch: z.number().int().positive().optional() })
      .strict()
      .parse(input)
    if (actor.role !== 'host') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    return this.transaction(() => {
      const old = this.owner(value.sessionId)
      if (
        old &&
        (old.host !== actor.deviceId ||
          old.state !== 'active' ||
          (value.epoch !== undefined && old.epoch !== value.epoch))
      )
        throw new ApiError('OWNER_CHANGED', 409)
      this.db
        .prepare(
          `INSERT INTO owners(session_id,host,epoch,lease_until) VALUES(?,?,1,?) ON CONFLICT(session_id) DO UPDATE SET lease_until=excluded.lease_until`,
        )
        .run(old ? String(old.sessionId) : value.sessionId, actor.deviceId, this.now() + 15_000)
      return this.owner(value.sessionId)
    })
  }
  enqueue(actor: Actor, input: unknown) {
    const packet = envelopeSchema.parse(input)
    if (actor.role !== 'client' || packet.sender !== actor.deviceId)
      throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    if (this.devices.get(packet.target).descriptor.role !== 'host')
      throw new ApiError('INVALID_TARGET')
    if (!this.devices.canLink(actor.deviceId, packet.target))
      throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    const encoded = JSON.stringify(packet),
      digest = hash(encoded)
    return this.transaction(() => {
      const old = this.db
        .prepare(
          'SELECT id,payload_hash,state,task_id AS taskId,revision FROM messages WHERE sender=? AND target=? AND session_id=? AND request_id=?',
        )
        .get(actor.deviceId, packet.target, packet.sessionId, packet.requestId)
      if (old) {
        if (old.payload_hash !== digest) throw new ApiError('REQUEST_CONFLICT', 409)
        return {
          id: old.id,
          state: old.state,
          taskId: old.taskId,
          revision: old.revision,
          duplicate: true,
        }
      }
      const owner = this.owner(packet.sessionId)
      if (
        !owner ||
        owner.host !== packet.target ||
        owner.epoch !== packet.epoch ||
        owner.state !== 'active'
      )
        throw new ApiError('OWNER_CHANGED', 409)
      if (packet.expiresAt <= this.now() || packet.expiresAt > this.now() + 7 * 86400_000)
        throw new ApiError('COMMAND_EXPIRED', 409)
      if (
        Number(
          this.db
            .prepare("SELECT count(*) AS n FROM messages WHERE sender=? AND state='queued'")
            .get(actor.deviceId)!.n,
        ) >= 256
      )
        throw new ApiError('INBOX_FULL', 429)
      const row = this.db
        .prepare(
          'INSERT INTO messages(sender,target,session_id,request_id,epoch,expires_at,payload_hash,envelope,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          actor.deviceId,
          packet.target,
          packet.sessionId,
          packet.requestId,
          packet.epoch,
          packet.expiresAt,
          digest,
          encoded,
          this.now(),
        )
      this.wake(packet.target)
      return { id: Number(row.lastInsertRowid), state: 'queued', revision: 0, duplicate: false }
    })
  }
  inbox(actor: Actor) {
    if (actor.role !== 'host') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    this.db
      .prepare(
        "UPDATE messages SET state='expired',envelope='',revision=revision+1 WHERE state='queued' AND expires_at<=?",
      )
      .run(this.now())
    return this.db
      .prepare(
        "SELECT id,envelope FROM messages WHERE target=? AND state='queued' ORDER BY id LIMIT 10",
      )
      .all(actor.deviceId)
      .map((row) => ({ id: Number(row.id), envelope: JSON.parse(String(row.envelope)) }))
  }
  receipts(actor: Actor, input: unknown) {
    const value = z
      .object({ after: z.number().int().nonnegative().default(0) })
      .strict()
      .parse(input)
    return this.db
      .prepare(
        'SELECT id,target,session_id AS sessionId,request_id AS requestId,state,task_id AS taskId,revision,acknowledged FROM messages WHERE sender=? AND id>? AND acknowledged=0 ORDER BY id LIMIT 100',
      )
      .all(actor.deviceId, value.after)
  }
  taskReceipt(actor: Actor, input: unknown) {
    const value = z
      .object({
        id: z.number().int().positive(),
        state: z.enum([
          'accepted',
          'completed',
          'failed',
          'waiting_user',
          'interrupted',
          'cancelled',
          'rejected',
        ]),
        taskId: identifier.optional(),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input)
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM messages WHERE id=? AND target=?')
        .get(value.id, actor.deviceId)
      if (!row) throw new ApiError('MESSAGE_NOT_FOUND', 404)
      if (value.revision < Number(row.revision)) return { updated: false }
      if (['completed', 'cancelled', 'rejected', 'expired'].includes(String(row.state)))
        return { updated: false }
      this.db
        .prepare(
          "UPDATE messages SET state=?,task_id=?,revision=?,acknowledged=0,envelope='' WHERE id=?",
        )
        .run(value.state, value.taskId ?? null, value.revision, value.id)
      this.wake(String(row.sender))
      return { updated: true }
    })
  }
  acknowledge(actor: Actor, input: unknown) {
    const value = z
      .object({ id: z.number().int().positive(), revision: z.number().int().nonnegative() })
      .strict()
      .parse(input)
    this.db
      .prepare('UPDATE messages SET acknowledged=1 WHERE id=? AND sender=? AND revision=?')
      .run(value.id, actor.deviceId, value.revision)
    return { acknowledged: true }
  }
  beginTransfer(actor: Actor, input: unknown) {
    const value = z
      .object({
        sessionId: identifier,
        target: identifier,
        epoch: z.number().int().positive(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        requestId: identifier,
        scope: z.array(identifier).min(1).max(200).optional(),
      })
      .strict()
      .parse(input)
    if (
      actor.role !== 'host' ||
      this.devices.get(value.target).descriptor.role !== 'host' ||
      value.target === actor.deviceId
    )
      throw new ApiError('INVALID_TARGET')
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM owners WHERE session_id=?').get(value.sessionId)
      if (!old || old.host !== actor.deviceId || old.epoch !== value.epoch)
        throw new ApiError('OWNER_CHANGED', 409)
      if (
        old.state === 'transferring' &&
        old.target === value.target &&
        old.digest === value.digest
      )
        return { ticket: old.ticket, epoch: old.epoch }
      const scope = [...new Set(value.scope ?? [value.sessionId])].sort()
      if (!scope.includes(value.sessionId)) throw new ApiError('INVALID_HANDOFF')
      for (const id of scope) {
        const member = this.owner(id)
        if (
          !member ||
          member.host !== actor.deviceId ||
          member.state !== 'active' ||
          Number(
            this.db
              .prepare(
                "SELECT count(*) AS n FROM messages WHERE (session_id=? OR session_id=?) AND state IN ('queued','accepted','waiting_user')",
              )
              .get(id, String(member.targetSession ?? id))!.n,
          ) > 0
        )
          throw new ApiError('SESSION_BUSY', 409)
      }
      const ticket = randomUUID()
      for (const id of scope)
        this.db
          .prepare(
            "UPDATE owners SET state='transferring',lease_until=0,ticket=?,target=?,digest=? WHERE session_id=?",
          )
          .run(ticket, value.target, value.digest, id)
      this.db
        .prepare('INSERT INTO handoffs(ticket,source,target,root,digest,scope) VALUES(?,?,?,?,?,?)')
        .run(
          ticket,
          actor.deviceId,
          value.target,
          value.sessionId,
          value.digest,
          JSON.stringify(scope),
        )
      return { ticket, epoch: value.epoch }
    })
  }
  completeTransfer(actor: Actor, input: unknown) {
    const value = z
      .object({
        sessionId: identifier,
        ticket: identifier,
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        targetSession: identifier,
        targets: z.record(identifier, identifier).optional(),
      })
      .strict()
      .parse(input)
    return this.transaction(() => {
      const transfer = this.handoff(actor, { ticket: value.ticket })
      if (
        transfer.root !== value.sessionId ||
        transfer.digest !== value.digest ||
        transfer.target !== actor.deviceId
      )
        throw new ApiError('INVALID_HANDOFF', 409)
      const scope = JSON.parse(String(transfer.scope)) as string[]
      const targets = value.targets ?? { [value.sessionId]: value.targetSession }
      if (
        Object.keys(targets).length !== scope.length ||
        scope.some((id) => !targets[id]) ||
        targets[value.sessionId] !== value.targetSession
      )
        throw new ApiError('INVALID_HANDOFF', 409)
      const encoded = JSON.stringify(Object.fromEntries(scope.map((id) => [id, targets[id]])))
      if (transfer.targets && transfer.targets !== encoded)
        throw new ApiError('REQUEST_CONFLICT', 409)
      const row = this.db.prepare('SELECT * FROM owners WHERE session_id=?').get(value.sessionId)
      if (
        !row ||
        row.ticket !== value.ticket ||
        row.target !== actor.deviceId ||
        row.digest !== value.digest
      )
        throw new ApiError('INVALID_HANDOFF', 409)
      if (row.state === 'active' && row.host === actor.deviceId) return this.owner(value.sessionId)
      if (row.state !== 'transferring') throw new ApiError('INVALID_HANDOFF', 409)
      for (const id of scope)
        this.db
          .prepare(
            "UPDATE owners SET host=target,epoch=epoch+1,lease_until=?,state='active',target_session=? WHERE session_id=? AND ticket=?",
          )
          .run(this.now() + 15_000, targets[id], id, value.ticket)
      this.db
        .prepare("UPDATE handoffs SET state='completed',targets=? WHERE ticket=?")
        .run(encoded, value.ticket)
      return this.owner(value.sessionId)
    })
  }
  handoff(actor: Actor, input: unknown): Record<string, unknown> {
    const value = z.object({ ticket: identifier }).strict().parse(input)
    const transfer = this.db.prepare('SELECT * FROM handoffs WHERE ticket=?').get(value.ticket)
    if (
      actor.role !== 'host' ||
      !transfer ||
      ![transfer.source, transfer.target].includes(actor.deviceId)
    )
      throw new ApiError('INVALID_HANDOFF', 403)
    const scope = JSON.parse(String(transfer.scope)) as string[]
    return { ...transfer, owners: scope.map((id) => this.owner(id)) }
  }
  pushEndpoint(actor: Actor, input: unknown, allowedOrigin?: string) {
    const value = z
        .object({ endpoint: z.string().url().max(1024) })
        .strict()
        .parse(input),
      url = new URL(value.endpoint)
    if (
      !allowedOrigin ||
      url.origin !== new URL(allowedOrigin).origin ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new ApiError('PUSH_ORIGIN_NOT_ALLOWED', 403)
    this.db
      .prepare(
        'INSERT INTO push_devices VALUES(?,?) ON CONFLICT(device) DO UPDATE SET endpoint=excluded.endpoint',
      )
      .run(actor.deviceId, url.href)
    return { registered: true }
  }
  private wake(device: string) {
    this.db
      .prepare(
        'INSERT INTO push_jobs(device,due) VALUES(?,?) ON CONFLICT(device) DO UPDATE SET due=excluded.due',
      )
      .run(device, this.now())
  }
  async deliverPush() {
    for (const row of this.db
      .prepare(
        'SELECT p.device,p.endpoint,j.attempts FROM push_jobs j JOIN push_devices p ON p.device=j.device WHERE due<=? LIMIT 10',
      )
      .all(this.now())) {
      try {
        this.devices.get(String(row.device))
        const response = await fetch(String(row.endpoint), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'X-UnifiedPush': '1' },
          body: JSON.stringify({ type: 'sync_required' }),
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) throw new Error('Push failed')
        this.db.prepare('DELETE FROM push_jobs WHERE device=?').run(String(row.device))
      } catch {
        this.db
          .prepare('UPDATE push_jobs SET attempts=attempts+1,due=? WHERE device=?')
          .run(
            this.now() + Math.min(3600_000, 5000 * 2 ** Math.min(Number(row.attempts), 10)),
            String(row.device),
          )
      }
    }
  }
}
