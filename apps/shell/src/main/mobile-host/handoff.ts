import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  transferredSessionId,
  type ManagedSessionStore,
  type SessionBundle,
} from '@genoffice/project-store'
import type { AssistantTaskService } from '../agent-tasks/service'
import type { MobileHostDependencies } from './server'
import type { RemoteOwnership } from './ownership'
import type { HostServerApi } from '@bigdogoffice/remote-core/host'
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const key = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error('INVALID_HANDOFF')
  return value
}
const MAX = 32 * 1024 * 1024
interface Manifest {
  ticket: string
  digest: string
  bytes: number
  sourceSessionId: string
  target: string
  globalRoot: string
  sourceIds: string[]
  state: 'prepared' | 'completed'
  targetSession?: string
}
interface Preparation {
  sourceSessionId: string
  target: string
  requestId: string
  digest: string
  bytes: number
  globalRoot: string
  epoch: number
  scope: string[]
  sourceIds: string[]
  aborted?: boolean
}
/** Copy verified portable state while both executors are fenced; switch ownership only after import. */
export class SessionHandoff {
  constructor(
    private readonly directory: string,
    private readonly store: ManagedSessionStore,
    private readonly tasks: AssistantTaskService,
    private readonly ownership: RemoteOwnership,
    private readonly api: HostServerApi,
    private readonly hostId: string,
    private readonly results: MobileHostDependencies['results'],
    private readonly prepareExport: (id: string) => Promise<void>,
    private readonly prepareImport?: (id: string) => Promise<void>,
  ) {
    mkdirSync(directory, { recursive: true })
  }
  private file(ticket: string, suffix: string) {
    return join(this.directory, key(ticket) + suffix)
  }
  private manifest(ticket: string): Manifest {
    return JSON.parse(readFileSync(this.file(ticket, '.json'), 'utf8'))
  }
  private removeBytes(ticket: string, suffix: string) {
    const path = this.file(ticket, suffix)
    if (existsSync(path)) unlinkSync(path)
  }
  async prepare(sessionId: string, target: string, requestId: string) {
    key(target)
    key(requestId)
    for (const file of readdirSync(this.directory).filter((name) => name.endsWith('.json'))) {
      const prior = JSON.parse(readFileSync(join(this.directory, file), 'utf8')) as Manifest
      if (
        prior.sourceSessionId === sessionId &&
        prior.target === target &&
        ['prepared', 'completed'].includes(prior.state)
      )
        return prior
    }
    for (const file of readdirSync(this.directory).filter((name) => name.endsWith('.stage'))) {
      const stage = JSON.parse(readFileSync(join(this.directory, file), 'utf8')) as Preparation
      if (stage.sourceSessionId === sessionId && stage.target === target && !stage.aborted)
        return this.coordinate(stage)
    }
    if (this.store.info(sessionId).state !== 'active') throw new Error('SESSION_INACTIVE')
    const scope = this.store.scope(sessionId).map((meta) => meta.id)
    for (const id of scope) await this.ownership.ensure(id)
    const frozen: string[] = []
    let coordinated = false
    try {
      for (const id of scope) {
        await this.ownership.freeze(id)
        frozen.push(id)
      }
      if (
        scope.some((id) =>
          this.tasks.store
            .forSession(id)
            .some((task) => !['completed', 'failed', 'cancelled'].includes(task.state)),
        )
      )
        throw new Error('SESSION_BUSY')
      for (const id of scope) await this.prepareExport(id)
      const bundle = this.store.exportSession(sessionId)
      for (const item of bundle.sessions) {
        const results = await this.results(item.session.meta.id)
        if (results) {
          item.results = results
          bundle.version = 3
        }
      }
      const globalIds = Object.fromEntries(
        scope.map((id) => [id, this.ownership.snapshot(id)!.globalId]),
      )
      const content = Buffer.from(JSON.stringify({ bundle, globalIds })),
        digest = hash(content)
      if (content.length > MAX) throw new Error('HANDOFF_TOO_LARGE')
      const source = this.ownership.snapshot(sessionId)!
      const stage: Preparation = {
        sourceSessionId: sessionId,
        target,
        requestId,
        digest,
        bytes: content.length,
        globalRoot: source.globalId,
        epoch: source.epoch!,
        scope: Object.values(globalIds),
        sourceIds: scope,
      }
      const stageKey = hash(requestId)
      writeFileSync(this.file(stageKey, '.payload'), content, { mode: 0o600 })
      writeFileSync(this.file(stageKey, '.stage'), JSON.stringify(stage), { mode: 0o600 })
      // A lost coordinator reply leaves the source fenced and this durable preparation retryable.
      coordinated = true
      return await this.coordinate(stage)
    } catch (error) {
      if (!coordinated) for (const id of frozen) await this.ownership.activate(id).catch(() => {})
      throw error
    }
  }
  private async coordinate(stage: Preparation) {
    let receipt
    try {
      receipt = await this.api.courier('handoff/begin', {
        sessionId: stage.globalRoot,
        target: stage.target,
        epoch: stage.epoch,
        digest: stage.digest,
        requestId: stage.requestId,
        scope: stage.scope,
      })
    } catch (error) {
      const owner = await this.api.courier('owner/' + stage.globalRoot).catch(() => null)
      if (owner?.host === this.hostId && owner.state === 'active' && owner.epoch === stage.epoch) {
        stage.aborted = true
        writeFileSync(this.file(hash(stage.requestId), '.stage'), JSON.stringify(stage), {
          mode: 0o600,
        })
        for (const id of stage.sourceIds) await this.ownership.activate(id).catch(() => {})
      }
      throw error
    }
    const content = readFileSync(this.file(hash(stage.requestId), '.payload'))
    if (hash(content) !== stage.digest) throw new Error('HANDOFF_CORRUPT')
    const manifest: Manifest = {
      ticket: receipt.ticket,
      digest: stage.digest,
      bytes: stage.bytes,
      sourceSessionId: stage.sourceSessionId,
      target: stage.target,
      globalRoot: stage.globalRoot,
      sourceIds: stage.sourceIds,
      state: 'prepared',
    }
    writeFileSync(this.file(manifest.ticket, '.bundle'), content, { mode: 0o600 })
    writeFileSync(this.file(manifest.ticket, '.json'), JSON.stringify(manifest), { mode: 0o600 })
    return manifest
  }
  read(sessionId: string, ticket: string, offset: number) {
    const manifest = this.manifest(ticket)
    if (
      manifest.sourceSessionId !== sessionId ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > manifest.bytes
    )
      throw new Error('INVALID_HANDOFF')
    const bytes = readFileSync(this.file(ticket, '.bundle')),
      end = Math.min(bytes.length, offset + 192 * 1024)
    if (hash(bytes) !== manifest.digest) throw new Error('HANDOFF_CORRUPT')
    return {
      base64: bytes.subarray(offset, end).toString('base64'),
      nextOffset: end,
      done: end === bytes.length,
    }
  }
  async upload(manifest: Manifest, offset: number, base64: string) {
    key(manifest.ticket)
    if (
      manifest.target !== this.hostId ||
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.bytes < 1 ||
      manifest.bytes > MAX ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof base64 !== 'string' ||
      base64.length > 270000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    )
      throw new Error('INVALID_HANDOFF')
    const state = await this.api.courier('handoff/status', { ticket: manifest.ticket })
    if (
      state.target !== this.hostId ||
      state.digest !== manifest.digest ||
      state.root !== manifest.globalRoot
    )
      throw new Error('INVALID_HANDOFF')
    const path = this.file(manifest.ticket, '.incoming'),
      part = Buffer.from(base64, 'base64')
    const current = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
    if (offset > current.length || offset + part.length > manifest.bytes)
      throw new Error('HANDOFF_OFFSET')
    const overlap = Math.max(0, Math.min(part.length, current.length - offset))
    if (!current.subarray(offset, offset + overlap).equals(part.subarray(0, overlap)))
      throw new Error('REQUEST_CONFLICT')
    if (overlap < part.length) appendFileSync(path, part.subarray(overlap), { mode: 0o600 })
    return { nextOffset: Math.max(current.length, offset + part.length) }
  }
  async accept(manifest: Manifest) {
    const state = await this.api.courier('handoff/status', { ticket: key(manifest.ticket) })
    if (
      state.target !== this.hostId ||
      state.digest !== manifest.digest ||
      state.root !== manifest.globalRoot
    )
      throw new Error('INVALID_HANDOFF')
    if (state.state === 'completed' && state.targets) {
      const importedTargets = JSON.parse(String(state.targets)) as Record<string, string>
      const localId = key(importedTargets[String(state.root)])
      // A permanent purge must never be undone by replaying an old handoff.
      for (const id of Object.values(importedTargets)) this.store.info(key(id))
      if (
        Object.values(importedTargets).every(
          (id) => this.ownership.snapshot(id)?.state === 'active',
        )
      ) {
        if (this.store.info(localId).state === 'active') await this.prepareImport?.(localId)
        this.removeBytes(manifest.ticket, '.incoming')
        return { sessionId: localId }
      }
    }
    const bytes = readFileSync(this.file(manifest.ticket, '.incoming'))
    if (bytes.length !== manifest.bytes || bytes.length > MAX || hash(bytes) !== manifest.digest)
      throw new Error('HANDOFF_CORRUPT')
    const payload = JSON.parse(bytes.toString()) as {
      bundle: SessionBundle
      globalIds: Record<string, string>
    }
    if (!payload.bundle?.sessions || payload.globalIds[payload.bundle.rootId] !== state.root)
      throw new Error('INVALID_HANDOFF')
    const expected = (JSON.parse(state.scope) as string[]).sort(),
      actual = Object.values(payload.globalIds).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('INVALID_HANDOFF')
    const targets: Record<string, string> = {}
    for (const item of payload.bundle.sessions) {
      const oldId = item.session.meta.id,
        globalId = payload.globalIds[oldId],
        localId = transferredSessionId(manifest.ticket, oldId)
      const owner = state.owners.find(
        (entry: { sessionId: string }) => entry.sessionId === globalId,
      )
      if (!owner) throw new Error('INVALID_HANDOFF')
      this.ownership.stage(
        localId,
        globalId,
        Number(owner.epoch) + (state.state === 'completed' ? 0 : 1),
      )
      targets[globalId] = localId
    }
    const imported = this.store.importSession(payload.bundle, {
      requestId: manifest.ticket,
      archived: true,
    })
    await this.api.courier('handoff/complete', {
      sessionId: state.root,
      ticket: manifest.ticket,
      digest: manifest.digest,
      targetSession: imported.id,
      targets,
    })
    for (const id of Object.values(targets)) await this.ownership.activate(id)
    this.store.archive(imported.id, false)
    await this.prepareImport?.(imported.id)
    this.removeBytes(manifest.ticket, '.incoming')
    return { sessionId: imported.id }
  }
  async finalize(ticket: string) {
    const manifest = this.manifest(ticket),
      state = await this.api.courier('handoff/status', { ticket })
    if (state.state !== 'completed') return { completed: false }
    for (const id of manifest.sourceIds) this.ownership.transferred(id)
    if (this.store.info(manifest.sourceSessionId).state === 'active')
      this.store.archive(manifest.sourceSessionId, true)
    manifest.state = 'completed'
    manifest.targetSession = JSON.parse(String(state.targets))[manifest.globalRoot]
    writeFileSync(this.file(ticket, '.json'), JSON.stringify(manifest), { mode: 0o600 })
    this.removeBytes(ticket, '.bundle')
    for (const file of readdirSync(this.directory).filter((name) => name.endsWith('.stage'))) {
      const stage = JSON.parse(readFileSync(join(this.directory, file), 'utf8')) as Preparation
      if (stage.sourceSessionId === manifest.sourceSessionId && stage.digest === manifest.digest)
        this.removeBytes(hash(stage.requestId), '.payload')
    }
    return { completed: true }
  }
  async reconcile() {
    for (const file of readdirSync(this.directory).filter((name) => name.endsWith('.json'))) {
      const manifest = JSON.parse(readFileSync(join(this.directory, file), 'utf8')) as Manifest
      if (manifest.state === 'prepared') await this.finalize(manifest.ticket).catch(() => {})
    }
  }
}
