import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorkspaceAgentEvent } from '../../shared/workspace-agent-api'

const MAX_EVENTS = 4_000
const STREAM_WRITE_INTERVAL_MS = 100

export interface HarnessEventLogFile {
  version: 1
  sessionId?: string
  nextSequence: number
  events: WorkspaceAgentEvent[]
}

/** Durable, monotonic event log used as the source for Session replay. */
export class HarnessEventLog {
  private readonly values: WorkspaceAgentEvent[] = []
  private sequenceValue: number
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private revision = 0
  private committedRevision = 0
  private pendingStreamWrite: Promise<void> | null = null

  constructor(
    readonly sessionId: string,
    private readonly filePath?: string,
    initial: readonly WorkspaceAgentEvent[] = [],
    initialSequence = 0,
  ) {
    this.values.push(
      ...initial
        .filter((event) => isEvent(event) && event.sessionId === sessionId)
        .slice(-MAX_EVENTS),
    )
    this.sequenceValue = Math.max(
      safeSequence(initialSequence),
      ...this.values.map((event) => (typeof event.sequence === 'number' ? event.sequence : 0)),
    )
  }

  get nextSequence(): number {
    return this.sequenceValue + 1
  }

  get lastSequence(): number {
    return this.sequenceValue
  }

  /** Merge a file written by a previous process without duplicating events. */
  async hydrate(): Promise<void> {
    if (!this.filePath) return
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      const file = normalizeFile(parsed)
      if (!file || (file.sessionId !== undefined && file.sessionId !== this.sessionId)) return
      const seen = new Set(this.values.map((event) => event.id))
      for (const event of file.events) {
        if (event.sessionId === this.sessionId && !seen.has(event.id)) {
          this.values.push(event)
          seen.add(event.id)
        }
      }
      // Transcript snapshots may already contain newer events than the file.
      // Sort before trimming, otherwise stale disk entries evict the newest tail.
      this.values.sort(compareEvents)
      this.values.splice(0, Math.max(0, this.values.length - MAX_EVENTS))
      this.sequenceValue = Math.max(
        this.sequenceValue,
        file.nextSequence - 1,
        ...this.values.map((event) => (typeof event.sequence === 'number' ? event.sequence : 0)),
      )
    } catch {
      // A missing/corrupt event file should not make a valid transcript
      // unusable; the persisted session record remains a fallback source.
    }
  }

  allocateSequence(): number {
    this.sequenceValue += 1
    return this.sequenceValue
  }

  append(event: WorkspaceAgentEvent): void {
    if (typeof event.sequence === 'number')
      this.sequenceValue = Math.max(this.sequenceValue, event.sequence)
    this.values.push(event)
    if (this.values.length > MAX_EVENTS) this.values.splice(0, this.values.length - MAX_EVENTS)
    this.dirty = true
    this.revision++
    const streaming =
      event.type === 'assistant.reasoning_summary' ||
      (event.type === 'assistant.message' && event.role !== 'user')
    if (!streaming) this.writePending()
    else if (this.filePath && this.writeTimer === undefined) {
      // Keep every in-memory/IPC event, but serialize a token burst only once.
      // Discrete events (especially approvals and terminal statuses) drain it
      // immediately, before their subscribers are notified by the service.
      this.writeTimer = setTimeout(() => this.writeStreaming(), STREAM_WRITE_INTERVAL_MS)
      this.writeTimer.unref?.()
    }
  }

  records(afterSequence = 0): WorkspaceAgentEvent[] {
    return this.values
      .filter((event) => typeof event.sequence !== 'number' || event.sequence > afterSequence)
      .sort(compareEvents)
  }

  snapshot(): WorkspaceAgentEvent[] {
    return this.records(-1)
  }

  async flush(): Promise<void> {
    this.writePending()
    // Also drain superseded asynchronous writes and their temp-file cleanup.
    // A caller may delete the session immediately after this resolves.
    await this.pendingStreamWrite
    this.writePending()
  }

  /** Stream bursts use asynchronous disk I/O. Discrete events retain their
   * synchronous durability barrier; revision checks prevent a stale stream
   * write from replacing a newer approval/completion snapshot. */
  private writeStreaming(): void {
    this.writeTimer = undefined
    if (!this.filePath || !this.dirty || this.pendingStreamWrite) return
    const filePath = this.filePath
    const revision = this.revision
    const pending = (async () => {
      let temp: string | undefined
      try {
        const payload: HarnessEventLogFile = {
          version: 1,
          sessionId: this.sessionId,
          nextSequence: this.nextSequence,
          events: this.values,
        }
        const serialized = JSON.stringify(payload)
        await mkdir(dirname(filePath), { recursive: true })
        temp = `${filePath}.${randomUUID()}.tmp`
        await writeFile(temp, serialized, { flag: 'wx' })
        if (revision > this.committedRevision) {
          // Keep the revision check and atomic replacement in one JS turn.
          renameSync(temp, filePath)
          temp = undefined
          this.committedRevision = revision
          this.dirty = revision < this.revision
        }
      } catch {
        // Retain dirty state for the next burst or explicit flush.
      } finally {
        if (temp) await rm(temp, { force: true }).catch(() => {})
      }
    })()
    this.pendingStreamWrite = pending
    void pending.then(() => {
      if (this.pendingStreamWrite === pending) this.pendingStreamWrite = null
      if (this.dirty && this.revision > revision && this.writeTimer === undefined) {
        this.writeTimer = setTimeout(() => this.writeStreaming(), STREAM_WRITE_INTERVAL_MS)
        this.writeTimer.unref?.()
      }
    })
  }

  private writePending(): void {
    if (this.writeTimer !== undefined) clearTimeout(this.writeTimer)
    this.writeTimer = undefined
    if (!this.filePath || !this.dirty) return
    let temp: string | undefined
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const payload: HarnessEventLogFile = {
        version: 1,
        sessionId: this.sessionId,
        nextSequence: this.nextSequence,
        events: this.values,
      }
      temp = `${this.filePath}.${randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify(payload), { flag: 'wx' })
      renameSync(temp, this.filePath)
      this.committedRevision = this.revision
      this.dirty = false
    } catch {
      // Event persistence is best effort; the transcript snapshot remains a
      // fallback source and a transient locked directory must not abort a run.
      if (temp) {
        try {
          rmSync(temp, { force: true })
        } catch {
          // Only this write's temporary file is eligible for cleanup.
        }
      }
    }
  }
}

function normalizeFile(value: unknown): HarnessEventLogFile | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.events)) return null
  const events = record.events.filter(isEvent)
  const nextSequence = safeSequence(record.nextSequence) || 1
  return {
    version: 1,
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    nextSequence: Math.max(1, Math.trunc(nextSequence)),
    events,
  }
}

function isEvent(value: unknown): value is WorkspaceAgentEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return (
    typeof event.id === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.type === 'string' &&
    typeof event.timestamp === 'string' &&
    (event.sequence === undefined || safeSequence(event.sequence) > 0)
  )
}

function safeSequence(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function compareEvents(a: WorkspaceAgentEvent, b: WorkspaceAgentEvent): number {
  if (typeof a.sequence === 'number' && typeof b.sequence === 'number')
    return a.sequence - b.sequence
  return a.timestamp.localeCompare(b.timestamp)
}
