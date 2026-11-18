import { createHash, randomUUID } from 'node:crypto'

export interface PortableResultLocation {
  kind: 'block' | 'cell' | 'sheet' | 'slide' | 'page' | 'line' | 'file' | 'resource'
  blockId?: string
  index?: number
  sheet?: string
  sheetId?: string
  range?: string
  slide?: number
  slideId?: string
  elementId?: string
  page?: number
  line?: number
  category?: 'styles' | 'chart' | 'image' | 'layout' | 'pdf' | 'package'
  name?: string
}
export interface PortableResultDifference {
  id: string
  location: PortableResultLocation
  kind: 'text' | 'format' | 'structure' | 'content'
  before?: string | undefined
  after?: string | undefined
  beforeDigest?: string | undefined
  afterDigest?: string | undefined
  truncated?: boolean
}
export interface PortableResultFile {
  id: string
  name: string
  type: string
  operation: 'created' | 'modified' | 'deleted'
  saveState: 'memory_only' | 'pending_save' | 'saved' | 'unknown'
  verification: 'passed' | 'failed' | 'unknown'
  scope?: string | undefined
  beforeVersion?: string | undefined
  afterVersion?: string | undefined
  diskVersion?: string | undefined
  details: PortableResultDifference[]
  incomplete?: boolean
  omitted?: number | undefined
  artifactId?: string | undefined
}
export interface PortableResultRecord {
  id: string
  taskId?: string
  occurredAt: string
  origin: 'local' | 'imported'
  outcome: 'completed' | 'partial' | 'failed' | 'cancelled' | 'undone' | 'undo-failed'
  files: PortableResultFile[]
}
export interface PortableResultArtifact {
  id: string
  name: string
  sha256: string
  byteLength: number
  base64: string
}
export interface PortableResults {
  version: 1
  records: PortableResultRecord[]
  artifacts: PortableResultArtifact[]
}
export const PORTABLE_RESULT_LIMIT = 64 * 1024 * 1024
export const PORTABLE_ARTIFACT_LIMIT = 24 * 1024 * 1024
const known = new Set([
  'docx',
  'xlsx',
  'xlsm',
  'pptx',
  'pdf',
  'md',
  'txt',
  'csv',
  'json',
  'html',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'unknown',
  'directory',
])
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid session result record.')
  return value as Record<string, unknown>
}
const string = (value: unknown, cap: number) => {
  if (typeof value !== 'string' || value.length > cap)
    throw new Error('Invalid session result text.')
  return value
}
const identity = (value: unknown) => {
  const id = string(value, 64)
  if (!/^[a-f0-9-]{20,64}$/i.test(id)) throw new Error('Invalid session result identity.')
  return id
}
const revision = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))
    throw new Error('Invalid session result revision.')
  return value
}
const pick = <T extends string>(value: unknown, options: readonly T[]): T => {
  if (!options.includes(value as T)) throw new Error('Invalid session result state.')
  return value as T
}
export function portableFilename(value: unknown): string {
  const name = string(value, 240)
  if (
    !name ||
    /^[. ]+$/.test(name) ||
    /[<>:"/\\|?*]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(name)
  )
    throw new Error('Invalid session artifact name.')
  return name
}
function location(value: unknown): PortableResultLocation {
  const row = object(value)
  const output: PortableResultLocation = {
    kind: pick(row.kind, [
      'block',
      'cell',
      'sheet',
      'slide',
      'page',
      'line',
      'file',
      'resource',
    ] as const),
  }
  for (const key of ['index', 'slide', 'page', 'line'] as const)
    if (row[key] !== undefined) {
      const number = row[key]
      if (
        typeof number !== 'number' ||
        !Number.isSafeInteger(number) ||
        number < 0 ||
        number > 10_000_000
      )
        throw new Error('Invalid result location.')
      output[key] = number
    }
  for (const key of [
    'blockId',
    'sheet',
    'sheetId',
    'range',
    'slideId',
    'elementId',
    'name',
  ] as const)
    if (row[key] !== undefined) output[key] = string(row[key], 320)
  if (row.category !== undefined)
    output.category = pick(row.category, [
      'styles',
      'chart',
      'image',
      'layout',
      'pdf',
      'package',
    ] as const)
  return output
}

/** Whitelist only history and verified copies. Portable records never carry runtime authority. */
export function normalizePortableResults(value: unknown, imported = false): PortableResults {
  if (Buffer.byteLength(JSON.stringify(value)) > PORTABLE_RESULT_LIMIT)
    throw new Error('Session results exceed the package limit.')
  const packet = object(value)
  if (
    packet.version !== 1 ||
    !Array.isArray(packet.records) ||
    packet.records.length > 2_000 ||
    !Array.isArray(packet.artifacts) ||
    packet.artifacts.length > 256
  )
    throw new Error('Unsupported session results.')
  const artifacts: PortableResultArtifact[] = [],
    mapping = new Map<string, string>()
  let bytes = 0
  for (const value of packet.artifacts) {
    const row = object(value),
      oldId = identity(row.id),
      name = portableFilename(row.name),
      base64 = string(row.base64, PORTABLE_ARTIFACT_LIMIT * 2)
    if (mapping.has(oldId)) throw new Error('Duplicate session artifact.')
    const body = Buffer.from(base64, 'base64'),
      sha256 = createHash('sha256').update(body).digest('hex')
    bytes += body.byteLength
    if (
      !body.length ||
      bytes > PORTABLE_ARTIFACT_LIMIT ||
      body.toString('base64') !== base64 ||
      body.byteLength !== row.byteLength ||
      sha256 !== row.sha256
    )
      throw new Error('Session artifact verification failed.')
    const id = imported ? randomUUID() : oldId
    mapping.set(oldId, id)
    artifacts.push({ id, name, sha256, byteLength: body.byteLength, base64 })
  }
  const ids = new Set<string>()
  const records = packet.records.map((value): PortableResultRecord => {
    const row = object(value),
      oldId = identity(row.id),
      occurredAt = string(row.occurredAt, 45)
    if (
      ids.has(oldId) ||
      !Number.isFinite(Date.parse(occurredAt)) ||
      !Array.isArray(row.files) ||
      row.files.length > 512
    )
      throw new Error('Invalid session result record.')
    ids.add(oldId)
    return {
      id: imported ? randomUUID() : oldId,
      occurredAt,
      ...(row.taskId === undefined ? {} : { taskId: string(row.taskId, 128) }),
      origin: imported || row.origin === 'imported' ? 'imported' : 'local',
      outcome: pick(row.outcome, [
        'completed',
        'partial',
        'failed',
        'cancelled',
        'undone',
        'undo-failed',
      ] as const),
      files: row.files.map((value): PortableResultFile => {
        const file = object(value),
          id = identity(file.id),
          type = string(file.type, 20),
          diskVersion = revision(file.diskVersion)
        if (!known.has(type) || !Array.isArray(file.details) || file.details.length > 100)
          throw new Error('Invalid session result file.')
        let artifactId: string | undefined
        if (file.artifactId !== undefined) {
          artifactId = mapping.get(identity(file.artifactId))
          const artifact = artifacts.find((value) => value.id === artifactId)
          if (
            !artifact ||
            artifact.sha256 !== diskVersion ||
            file.saveState !== 'saved' ||
            file.verification !== 'passed'
          )
            throw new Error('Session artifact has no matching verified result.')
        }
        return {
          id: imported ? randomUUID() : id,
          name: portableFilename(file.name),
          type,
          operation: pick(file.operation, ['created', 'modified', 'deleted'] as const),
          saveState: pick(file.saveState, [
            'memory_only',
            'pending_save',
            'saved',
            'unknown',
          ] as const),
          verification: pick(file.verification, ['passed', 'failed', 'unknown'] as const),
          scope: file.scope === undefined ? undefined : string(file.scope, 64),
          beforeVersion: revision(file.beforeVersion),
          afterVersion: revision(file.afterVersion),
          diskVersion,
          artifactId,
          incomplete: file.incomplete === true,
          omitted:
            typeof file.omitted === 'number' && Number.isSafeInteger(file.omitted)
              ? Math.max(0, Math.min(10_000_000, file.omitted))
              : undefined,
          details: file.details.map((value): PortableResultDifference => {
            const detail = object(value),
              id = identity(detail.id)
            return {
              id: imported ? randomUUID() : id,
              location: location(detail.location),
              kind: pick(detail.kind, ['text', 'format', 'structure', 'content'] as const),
              before: detail.before === undefined ? undefined : string(detail.before, 1_250),
              after: detail.after === undefined ? undefined : string(detail.after, 1_250),
              beforeDigest: revision(detail.beforeDigest),
              afterDigest: revision(detail.afterDigest),
              truncated: detail.truncated === true,
            }
          }),
        }
      }),
    }
  })
  if (
    artifacts.some(
      (artifact) =>
        !records.some((record) => record.files.some((file) => file.artifactId === artifact.id)),
    )
  )
    throw new Error('Unreferenced session artifact.')
  return { version: 1, records, artifacts }
}
