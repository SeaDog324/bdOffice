import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { DocumentContextView } from '../../shared/document-context-api'
import type { WorkspaceFileType } from '../../shared/workspace-agent-api'
import type { DocumentSnapshot, LiveDocumentAdapter } from '../workspace-agent/service'

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_TICKETS = 32
const TICKET_TTL_MS = 2 * 60 * 60_000

export interface DocumentContextSource {
  instanceId: number
  name: string
  type: WorkspaceFileType
  path?: string
  adapter: LiveDocumentAdapter
  available(): boolean
  currentPath(): string | undefined
  dirty(): boolean
  captureCurrent?(): boolean
}
interface Ticket {
  view: DocumentContextView
  source: DocumentContextSource
  savedPath?: string
  invalidated?: boolean
}
export interface DocumentCaptureRequest {
  readonly epoch: number
}
const TARGET_CHANGED =
  'The document moved or was saved as another file. Refresh its context before continuing.'
const physicalPath = (path: string) => {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}
const canonicalKey = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const pathKey = (path: string) => canonicalKey(physicalPath(path))
export function documentSnapshotDigest(snapshot: DocumentSnapshot): string {
  if (snapshot.bytesBase64.length > Math.ceil((MAX_SNAPSHOT_BYTES * 4) / 3))
    throw new Error('The current document exceeds the context snapshot limit.')
  return createHash('sha256').update(snapshot.bytesBase64).digest('hex')
}

/** In-flight binding. Snapshot contents never go to the renderer or the model. */
export interface BoundDocumentContext {
  view: DocumentContextView
  adapter: LiveDocumentAdapter
  matches(path: string): boolean
  assertAvailable(): void
  filePath(): string | undefined
}

export class DocumentContextService {
  private readonly tickets = new Map<string, Ticket>()
  private readonly fileIds = new Map<string, string>()
  private currentId: string | null = null
  private captureEpoch = 0
  private captureRequest: DocumentCaptureRequest | null = null
  private failure: string | null = null
  private refreshTicket: Ticket | null = null
  constructor(private readonly liveRoot: string) {}

  current(): DocumentContextView | null {
    const ticket = this.currentId ? this.tickets.get(this.currentId) : undefined
    if (!ticket) return null
    if (!ticket.source.available()) {
      this.currentId = null
      return null
    }
    const filePath = ticket.source.currentPath()
    if (!this.observeTarget(ticket, filePath)) return null
    return {
      ...structuredClone(ticket.view),
      dirty: ticket.source.dirty(),
      memoryOnly: !filePath,
      ...(filePath ? { filePath: physicalPath(filePath) } : {}),
    }
  }
  error(): string | null {
    return this.failure
  }
  clear(): void {
    this.captureEpoch++
    this.captureRequest = null
    this.currentId = null
    this.failure = null
    this.refreshTicket = null
  }
  beginCapture(): DocumentCaptureRequest {
    this.refreshTicket = null
    const request = Object.freeze({ epoch: ++this.captureEpoch })
    this.captureRequest = request
    return request
  }
  isCurrentCapture(request: DocumentCaptureRequest): boolean {
    return this.captureRequest === request
  }
  captureFailed(error: unknown, request: DocumentCaptureRequest): boolean {
    if (!this.isCurrentCapture(request)) return false
    this.currentId = null
    this.failure = error instanceof Error ? error.message : 'Document context is unavailable.'
    return true
  }

  private invalidate(ticket: Ticket): false {
    ticket.invalidated = true
    if (this.currentId === ticket.view.id || this.refreshTicket === ticket) {
      this.currentId = null
      this.refreshTicket = null
      this.failure = TARGET_CHANGED
    }
    return false
  }

  private observeTarget(ticket: Ticket, path: string | undefined): boolean {
    if (ticket.invalidated) return false
    if (!path) return ticket.savedPath ? this.invalidate(ticket) : true
    const physical = physicalPath(path)
    if (ticket.savedPath) {
      return canonicalKey(physical) === canonicalKey(ticket.savedPath) || this.invalidate(ticket)
    }
    // First Save fixes the target for every binding of this untitled ticket.
    ticket.savedPath = physical
    this.fileIds.set(canonicalKey(physical), ticket.view.fileId)
    const editorKey = 'editor:' + ticket.source.instanceId
    if (this.fileIds.get(editorKey) === ticket.view.fileId) this.fileIds.delete(editorKey)
    return true
  }

  /** Called by the host after a successful first save/Save As, including between Agent steps. */
  noteSaved(instanceId: number, path: string): void {
    for (const ticket of this.tickets.values()) {
      if (ticket.source.instanceId === instanceId) this.observeTarget(ticket, path)
    }
  }

  /** Refresh the same selected document for a new user turn, without retargeting old runs. */
  async refreshCurrent(): Promise<void> {
    const ticket = this.currentId ? this.tickets.get(this.currentId) : this.refreshTicket
    if (!ticket) return
    const source = ticket.source
    if (!source.available()) {
      this.currentId = null
      this.refreshTicket = null
      this.failure = null
      return
    }
    const path = source.currentPath()
    if (!this.observeTarget(ticket, path)) return
    const request = this.beginCapture()
    try {
      await this.capture(
        { ...source, path, name: path ? basename(path) : source.name, captureCurrent: undefined },
        request,
      )
    } catch (error) {
      if (this.captureFailed(error, request)) this.refreshTicket = ticket
    }
  }

  async capture(
    source: DocumentContextSource | null,
    request = this.beginCapture(),
  ): Promise<DocumentContextView | null> {
    if (!this.isCurrentCapture(request)) return null
    if (!source) return this.current()
    this.currentId = null
    this.failure = null
    const capturedPath = source.path ? physicalPath(source.path) : undefined
    const valid = () => {
      if (!source.available()) throw new Error('The current editor is no longer available.')
      if (source.captureCurrent?.() === false)
        throw new Error('The active document changed during context capture.')
      if (source.currentPath() !== source.path)
        throw new Error('The current document changed while its context was captured.')
      if (source.path && physicalPath(source.path) !== capturedPath)
        throw new Error('The current file target changed during context capture.')
    }
    valid()
    const before = documentSnapshotDigest(await source.adapter.snapshot())
    const editor = await source.adapter.getContext?.()
    const after = documentSnapshotDigest(await source.adapter.snapshot())
    valid()
    if (before !== after)
      throw new Error('The document changed while its context was captured. Open AI BigDog again.')
    if (!this.isCurrentCapture(request)) return null
    const identity = source.path ? pathKey(source.path) : 'editor:' + source.instanceId
    let fileId = this.fileIds.get(identity)
    if (!fileId) {
      fileId = randomUUID()
      this.fileIds.set(identity, fileId)
    }
    const view: DocumentContextView = {
      id: randomUUID(),
      fileId,
      path: capturedPath ?? join(this.liveRoot, fileId + '.' + source.type),
      name: source.name || (source.path ? basename(source.path) : 'Untitled'),
      type: source.type,
      instanceId: source.instanceId,
      contentDigest: after,
      capturedAt: Date.now(),
      dirty: source.dirty(),
      memoryOnly: !source.path,
      ...(editor ? { editor } : {}),
    }
    this.tickets.set(view.id, { view, source, savedPath: capturedPath })
    this.currentId = view.id
    for (const [id, ticket] of this.tickets) {
      if (
        id !== this.currentId &&
        (this.tickets.size > MAX_TICKETS || Date.now() - ticket.view.capturedAt > TICKET_TTL_MS)
      )
        this.tickets.delete(id)
    }
    return structuredClone(view)
  }

  /** Only known, still-open untitled references bypass filesystem resolution. */
  liveReference(path: string): DocumentContextSource | undefined {
    for (const ticket of this.tickets.values()) {
      const { view, source } = ticket
      if (
        view.memoryOnly &&
        canonicalKey(view.path) === pathKey(path) &&
        source.available() &&
        this.observeTarget(ticket, source.currentPath())
      )
        return source
    }
    return undefined
  }

  async bind(id: string): Promise<BoundDocumentContext> {
    const ticket = this.tickets.get(id)
    if (!ticket || Date.now() - ticket.view.capturedAt > TICKET_TTL_MS)
      throw new Error('The document context expired. Open AI BigDog from the document again.')
    const { source, view } = ticket
    const bindingId = randomUUID()
    const assertAvailable = () => {
      if (!source.available())
        throw new Error('The original editor closed. Reopen the document before continuing.')
      const currentPath = source.currentPath()
      if (!this.observeTarget(ticket, currentPath)) throw new Error(TARGET_CHANGED)
    }
    assertAvailable()
    let expected = await source.adapter.snapshot()
    assertAvailable()
    if (documentSnapshotDigest(expected) !== view.contentDigest)
      throw new Error(
        'The document changed after it was selected. Refresh its context before editing.',
      )
    const check = async () => {
      assertAvailable()
      const snapshot = await source.adapter.snapshot()
      assertAvailable()
      if (documentSnapshotDigest(snapshot) !== documentSnapshotDigest(expected))
        throw new Error(
          'The document changed after it was selected. Refresh its context before editing.',
        )
    }
    const writes = new Set([
      'mutate',
      'save',
      'undo',
      'rollback',
      'restoreAgentRun',
      'applyVisionRepair',
    ])
    const adapter = new Proxy(source.adapter, {
      get(target, key, receiver) {
        if (key === 'bindingId') return bindingId
        const value = Reflect.get(target, key, receiver)
        if (typeof value !== 'function') return value
        return async (...args: unknown[]) => {
          assertAvailable()
          if (!writes.has(String(key))) return value.apply(target, args)
          await check()
          if (key === 'mutate' && target.mutateGuarded) {
            const guarded = await target.mutateGuarded(
              args[0] as Parameters<LiveDocumentAdapter['mutate']>[0],
              expected,
            )
            expected = guarded.snapshot
            view.contentDigest = documentSnapshotDigest(expected)
            return guarded.result
          }
          const result = await value.apply(target, args)
          assertAvailable()
          expected = await target.snapshot()
          view.contentDigest = documentSnapshotDigest(expected)
          return result
        }
      },
    })
    return {
      view: structuredClone(view),
      adapter,
      assertAvailable,
      filePath: () => {
        const path = source.currentPath()
        return source.available() && this.observeTarget(ticket, path) ? path : undefined
      },
      matches: (path) => {
        const currentPath = source.currentPath()
        if (source.available()) this.observeTarget(ticket, currentPath)
        const key = pathKey(path)
        // Intercept both the old reference and the editor's replacement target.
        // A failed binding must not fall back to an unguarded live/headless session.
        return (
          key === canonicalKey(view.path) ||
          key === pathKey(view.path) ||
          (!!ticket.savedPath &&
            (key === canonicalKey(ticket.savedPath) || key === pathKey(ticket.savedPath))) ||
          (!!currentPath && key === pathKey(currentPath))
        )
      },
    }
  }
}
