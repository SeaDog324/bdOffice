import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostServerApi } from '@bigdogoffice/remote-core/host'
interface RecordEntry {
  globalId: string
  epoch?: number
  state: 'active' | 'frozen' | 'transferred'
}
/** Persisted fencing survives restart. Missing/expired leases cannot authorize a write. */
export class RemoteOwnership {
  private records: Record<string, RecordEntry>
  private deadlines = new Map<string, number>()
  private api?: HostServerApi
  private pending = new Map<string, Promise<void>>()
  constructor(private readonly path: string) {
    this.records = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  }
  configure(api: HostServerApi) {
    this.api = api
  }
  private save() {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path + '.pending', JSON.stringify(this.records))
    renameSync(this.path + '.pending', this.path)
  }
  allowed(id: string) {
    return (
      !this.records[id] ||
      (this.records[id].state === 'active' && (this.deadlines.get(id) ?? 0) > performance.now())
    )
  }
  async ensure(id: string) {
    if (!this.api) return
    if (this.records[id]?.state === 'transferred' || this.records[id]?.state === 'frozen')
      throw new Error('OWNER_CHANGED')
    if (!this.records[id]) {
      this.records[id] = { globalId: id, state: 'active' }
      this.save()
    }
    if ((this.deadlines.get(id) ?? 0) > performance.now() + 3000) return
    if (this.pending.has(id)) return this.pending.get(id)
    const started = performance.now(),
      record = this.records[id]
    const promise = (async () => {
      const lease = await this.api!.courier('lease', {
        sessionId: record.globalId,
        ...(record.epoch ? { epoch: record.epoch } : {}),
      })
      if (this.records[id] !== record || record.state !== 'active') throw new Error('OWNER_CHANGED')
      record.epoch = lease.epoch
      this.save()
      this.deadlines.set(id, started + 10_000)
      if (!this.allowed(id)) throw new Error('LEASE_EXPIRED')
    })().finally(() => this.pending.delete(id))
    this.pending.set(id, promise)
    return promise
  }
  async renew() {
    for (const [id, record] of Object.entries(this.records))
      if (record.state === 'active') await this.ensure(id).catch(() => {})
  }
  async freeze(id: string) {
    await this.ensure(id)
    this.records[id].state = 'frozen'
    this.deadlines.delete(id)
    this.save()
    return this.records[id]
  }
  transferred(id: string) {
    if (this.records[id]) {
      this.records[id].state = 'transferred'
      this.deadlines.delete(id)
      this.save()
    }
  }
  stage(localId: string, globalId: string, epoch: number) {
    this.records[localId] = { globalId, epoch, state: 'frozen' }
    this.save()
  }
  activate(localId: string) {
    this.records[localId].state = 'active'
    this.save()
    return this.ensure(localId)
  }
  snapshot(id: string) {
    return this.records[id]
  }
  writeBlocked(id: string) {
    return Boolean(this.records[id] && this.records[id].state !== 'active')
  }
}
