import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentRunReview, RunReviewPage } from '../../shared/workspace-agent-api'

const id = (value: string) => {
  if (!/^[a-f0-9-]{20,64}$/i.test(value)) throw new Error('Invalid evidence identity.')
  return value
}
const filename = (review: AgentRunReview) =>
  `${Date.parse(review.completedAt)}-${id(review.id)}.json`
const validName = (value: string) => /^\d{13}-[a-f0-9-]{20,64}\.json$/i.test(value)

/** Located result records outlive the bounded chat log and 20-run rollback window. */
export class RunEvidenceStore {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly removed = new Set<string>()
  constructor(
    private readonly root: string,
    private readonly projection?: {
      saved(sessionId: string, review: AgentRunReview): Promise<void> | void
      failed(sessionId: string, review: AgentRunReview): Promise<void> | void
    },
  ) {}
  private async directory(sessionId: string, create = true): Promise<string> {
    const path = join(this.root, id(sessionId))
    if (relative(this.root, path) !== sessionId) throw new Error('Invalid evidence directory.')
    const info = async (target: string) =>
      lstat(target).catch((error) => {
        if (error?.code === 'ENOENT') return null
        throw error
      })
    if (create) await mkdir(this.root, { recursive: true })
    if ((await info(this.root))?.isSymbolicLink()) throw new Error('Linked evidence storage.')
    if (create) await mkdir(path, { recursive: true })
    if ((await info(path))?.isSymbolicLink()) throw new Error('Linked evidence directory.')
    return path
  }
  async save(sessionId: string, review: AgentRunReview): Promise<void> {
    id(sessionId)
    if (this.removed.has(sessionId)) throw new Error('Evidence session was removed.')
    const pending = (this.pending.get(sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (this.removed.has(sessionId)) throw new Error('Evidence session was removed.')
        try {
          await this.write(sessionId, review)
          await this.projection?.saved(sessionId, review)
        } catch (error) {
          await this.projection?.failed(sessionId, review)
          throw error
        }
      })
    this.pending.set(sessionId, pending)
    try {
      await pending
    } finally {
      if (this.pending.get(sessionId) === pending) this.pending.delete(sessionId)
    }
  }
  /** Reconcile bounded derived memory under the same writer queue as new results. */
  async reconcile(
    sessionId: string,
    rebuild: (reviews: AgentRunReview[]) => Promise<void> | void,
  ): Promise<void> {
    id(sessionId)
    if (this.removed.has(sessionId)) return
    const pending = (this.pending.get(sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (this.removed.has(sessionId)) return
        const reviews: AgentRunReview[] = []
        let cursor: string | undefined
        do {
          const page = await this.list(sessionId, cursor)
          reviews.push(...page.reviews)
          cursor = page.nextCursor
        } while (cursor && reviews.length < 64)
        const seen = new Set<string>()
        await rebuild(
          reviews.slice(0, 64).filter((review) => {
            if (seen.has(review.id)) return false
            seen.add(review.id)
            return true
          }),
        )
      })
    this.pending.set(sessionId, pending)
    try {
      await pending
    } finally {
      if (this.pending.get(sessionId) === pending) this.pending.delete(sessionId)
    }
  }
  private async write(sessionId: string, review: AgentRunReview): Promise<void> {
    const directory = await this.directory(sessionId),
      name = filename(review)
    if (!validName(name)) throw new Error('Invalid evidence timestamp.')
    const destination = join(directory, name)
    const existing = await lstat(destination).catch((error) => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (existing?.isSymbolicLink()) throw new Error('Linked evidence record.')
    const json = JSON.stringify({ version: 1, sessionId, review })
    if (Buffer.byteLength(json) > 4 * 1024 * 1024)
      throw new Error('Evidence record exceeds its limit.')
    const temporary = join(directory, `.staging-${randomUUID()}`)
    try {
      await writeFile(temporary, json, { flag: 'wx' })
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  async list(sessionId: string, cursor?: string): Promise<RunReviewPage> {
    if (this.removed.has(sessionId)) return { reviews: [] }
    if (cursor !== undefined && !validName(cursor)) throw new Error('Invalid evidence cursor.')
    const directory = await this.directory(sessionId, false)
    const names = (
      await readdir(directory).catch((error) => {
        if (error?.code === 'ENOENT') return [] as string[]
        throw error
      })
    )
      .filter(validName)
      .filter((name) => !cursor || name < cursor)
      .sort()
      .reverse()
    const reviews: AgentRunReview[] = []
    // Preserve an unreadable record; report failure rather than inventing an empty result.
    for (const name of names.slice(0, 20)) {
      const path = join(directory, name),
        info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
        throw new Error('Invalid evidence record.')
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (
        value.version !== 1 ||
        value.sessionId !== sessionId ||
        filename(value.review) !== name ||
        !Array.isArray(value.review.changes)
      )
        throw new Error('Invalid evidence record.')
      reviews.push(value.review)
    }
    return { reviews, ...(names.length > 20 ? { nextCursor: names[19] } : {}) }
  }
  async get(sessionId: string, recordId: string): Promise<AgentRunReview | undefined> {
    id(recordId)
    if (this.removed.has(sessionId)) return undefined
    const directory = await this.directory(sessionId, false)
    const names = await readdir(directory).catch((error) => {
      if (error?.code === 'ENOENT') return [] as string[]
      throw error
    })
    const name = names
      .filter((value) => validName(value) && value.endsWith(`-${recordId}.json`))
      .sort()
      .at(-1)
    if (!name) return undefined
    const path = join(directory, name),
      info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new Error('Invalid evidence record.')
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (
      value.version !== 1 ||
      value.sessionId !== sessionId ||
      value.review?.id !== recordId ||
      filename(value.review) !== name ||
      !Array.isArray(value.review.changes)
    )
      throw new Error('Invalid evidence record.')
    return value.review
  }
  async all(sessionId: string): Promise<AgentRunReview[]> {
    const result: AgentRunReview[] = []
    let cursor: string | undefined
    do {
      const page = await this.list(sessionId, cursor)
      result.push(...page.reviews)
      if (result.length > 2_000)
        throw new Error('Session result history exceeds the transfer limit.')
      cursor = page.nextCursor
    } while (cursor)
    return result
  }
  async removeSession(sessionId: string): Promise<void> {
    id(sessionId)
    this.removed.add(sessionId)
    await this.pending.get(sessionId)?.catch(() => {})
    const directory = await this.directory(sessionId, false)
    await rm(directory, { recursive: true, force: true })
  }
}
