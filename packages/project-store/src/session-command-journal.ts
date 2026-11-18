import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import {
  SessionCommandError,
  parseSessionVersion,
  type SessionCommandReceipt,
} from './session-command-types.js'

const MAX_BYTES = 128 * 1024 * 1024
const MAX_RECEIPT_BYTES = 128 * 1024
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export interface SessionFileWrite {
  path: string
  before: string | null
  text: string
}
interface Pending {
  version: 1
  key: string
  fingerprint: string
  receipt: SessionCommandReceipt
  files: Array<SessionFileWrite & { after: string }>
}
export interface SessionCommandCheckpoint {
  phase: 'prepared' | 'applied' | 'receipted' | 'committed'
  path?: string
}
function atomic(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}
const recoveryError = () =>
  new SessionCommandError(
    'STORAGE_RECOVERY_REQUIRED',
    'A pending Session change conflicts with storage. Existing files have been preserved for review.',
  )
function validateReceipt(receipt: SessionCommandReceipt): void {
  if (
    !receipt ||
    typeof receipt.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.requestId) ||
    typeof receipt.sessionId !== 'string' ||
    !/^[0-9a-f-]{20,64}$/i.test(receipt.sessionId) ||
    receipt.duplicate !== false ||
    !Array.isArray(receipt.affectedSessionIds) ||
    receipt.affectedSessionIds.length > 1024 ||
    !receipt.affectedSessionIds.includes(receipt.sessionId) ||
    receipt.affectedSessionIds.some(
      (id) => typeof id !== 'string' || !/^[0-9a-f-]{20,64}$/i.test(id),
    )
  )
    throw recoveryError()
  try {
    parseSessionVersion(receipt.version)
  } catch {
    throw recoveryError()
  }
}

/** Process-restart redo journal for the single Host writer. No document paths from callers are accepted. */
export class SessionCommandJournal {
  private recovering = false
  constructor(
    private readonly root: string,
    private readonly checkpoint?: (value: SessionCommandCheckpoint) => void,
  ) {}
  private owned(path: string): void {
    const rel = relative(this.root, path)
    if (rel.startsWith('..') || rel.split(sep).includes('..')) throw recoveryError()
    let parent = this.root
    if (lstatSync(parent).isSymbolicLink()) throw recoveryError()
    for (const part of rel.split(sep)) {
      parent = join(parent, part)
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw recoveryError()
    }
  }
  private target(path: string): string {
    if (!/^(index\.json|sessions\/[0-9a-f-]{20,64}\/(session\.json|summary\.md))$/i.test(path))
      throw recoveryError()
    const full = join(this.root, path)
    this.owned(full)
    return full
  }
  private read(path: string, max: number): string {
    this.owned(path)
    if (statSync(path).size > max) throw recoveryError()
    return readFileSync(path, 'utf8')
  }
  private receiptPath(key: string): string {
    if (!hex(key)) throw recoveryError()
    const dir = join(this.root, 'commands')
    this.owned(dir)
    mkdirSync(dir, { recursive: true })
    return join(dir, `${key}.json`)
  }
  currentDigest(path: string): string | null {
    const full = this.target(path)
    return existsSync(full) ? digest(this.read(full, MAX_BYTES)) : null
  }
  receipt(key: string, fingerprint: string): SessionCommandReceipt | undefined {
    const path = this.receiptPath(key)
    if (!existsSync(path)) return undefined
    let value: Pending
    try {
      value = JSON.parse(this.read(path, MAX_RECEIPT_BYTES)) as Pending
    } catch {
      throw recoveryError()
    }
    if (
      !value ||
      value.version !== 1 ||
      value.key !== key ||
      !hex(value.fingerprint) ||
      !value.receipt
    )
      throw recoveryError()
    validateReceipt(value.receipt)
    if (value.fingerprint !== fingerprint)
      throw new SessionCommandError(
        'REQUEST_CONFLICT',
        'This request ID was already used for another Session command.',
      )
    return { ...value.receipt, duplicate: true }
  }
  recover(): boolean {
    if (this.recovering) return false
    const path = join(this.root, 'command-pending.json')
    if (!existsSync(path)) return false
    this.recovering = true
    try {
      const pending = JSON.parse(this.read(path, MAX_BYTES)) as Pending
      this.apply(pending)
      return true
    } catch (error) {
      if (error instanceof SessionCommandError) throw error
      throw recoveryError()
    } finally {
      this.recovering = false
    }
  }
  commit(
    key: string,
    fingerprint: string,
    receipt: SessionCommandReceipt,
    files: SessionFileWrite[],
  ): void {
    const pending: Pending = {
      version: 1,
      key,
      fingerprint,
      receipt,
      files: files.map((file) => ({ ...file, after: digest(file.text) })),
    }
    const text = JSON.stringify(pending)
    if (Buffer.byteLength(text) > MAX_BYTES)
      throw new SessionCommandError(
        'COMMAND_TOO_LARGE',
        'This Session change exceeds the transaction size limit.',
      )
    for (const file of files)
      if (this.currentDigest(file.path) !== file.before) throw recoveryError()
    const path = join(this.root, 'command-pending.json')
    this.owned(path)
    if (existsSync(path)) throw recoveryError()
    atomic(path, text)
    this.checkpoint?.({ phase: 'prepared' })
    this.apply(pending)
  }
  private apply(pending: Pending): void {
    if (
      pending.version !== 1 ||
      !hex(pending.key) ||
      !hex(pending.fingerprint) ||
      !Array.isArray(pending.files) ||
      pending.files.length > 2049 ||
      !pending.receipt ||
      typeof pending.receipt.sessionId !== 'string' ||
      !/^[0-9a-f-]{20,64}$/i.test(pending.receipt.sessionId) ||
      !pending.files.some((f) => f.path === 'index.json')
    )
      throw recoveryError()
    validateReceipt(pending.receipt)
    // Receipt publication follows all file writes. Only clean up a leftover intent; later external notes are authoritative.
    if (this.receipt(pending.key, pending.fingerprint)) {
      unlinkSync(join(this.root, 'command-pending.json'))
      return
    }
    const paths = new Set<string>()
    // Check the entire write set first. An externally edited note is never overwritten during recovery.
    for (const file of pending.files) {
      if (
        !file ||
        typeof file.path !== 'string' ||
        paths.has(file.path) ||
        typeof file.text !== 'string' ||
        !hex(file.after) ||
        file.after !== digest(file.text) ||
        (file.before !== null && !hex(file.before))
      )
        throw recoveryError()
      paths.add(file.path)
      const current = this.currentDigest(file.path)
      if (current !== file.before && current !== file.after) throw recoveryError()
    }
    for (const file of [...pending.files].sort(
      (a, b) => Number(a.path === 'index.json') - Number(b.path === 'index.json'),
    )) {
      const path = this.target(file.path)
      mkdirSync(dirname(path), { recursive: true })
      if (this.currentDigest(file.path) !== file.after) atomic(path, file.text)
      this.checkpoint?.({ phase: 'applied', path: file.path })
    }
    atomic(this.receiptPath(pending.key), JSON.stringify({ ...pending, files: undefined }))
    this.checkpoint?.({ phase: 'receipted' })
    unlinkSync(join(this.root, 'command-pending.json'))
    this.checkpoint?.({ phase: 'committed' })
  }
}
