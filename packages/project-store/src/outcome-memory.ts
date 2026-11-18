import type { PortableResultDifference, PortableResultRecord } from './result-evidence.js'

export const MAX_MEMORY_OUTCOMES = 128
const MAX_CHANGES = 10
const TEXT_LIMIT = 400
const revisions = /^[a-f0-9]{64}$/i
const identity = /^[a-f0-9-]{20,64}$/i
const scopes = new Set(['editor_model', 'package_bytes', 'text_values', 'file_bytes'])
const redact = (text: string) =>
  text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/g, '[credential omitted]')
    .replace(/((?:api[_ -]?key|password|access[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[omitted]')

/** Historical observations, never a grant or a claim about a file's current contents. */
export interface OutcomeMemoryEntry {
  id: string
  sourceSessionId: string
  kind: 'verified_outcome' | 'reported_context'
  origin: 'local' | 'imported'
  recordId: string
  taskId?: string
  evidenceId: string
  recordedAt: string
  status: 'observed' | 'reverted' | 'uncertain'
  resultOutcome: PortableResultRecord['outcome']
  file: {
    name: string
    type: string
    path?: string
    documentId?: string
    operation: 'created' | 'modified' | 'deleted'
    saveState: 'memory_only' | 'pending_save' | 'saved' | 'unknown'
    scope: string
    beforeVersion?: string | undefined
    afterVersion?: string | undefined
    diskVersion?: string | undefined
  }
  changes: PortableResultDifference[]
  omitted: number
  incomplete: boolean
}

export interface OutcomeDocumentReference {
  path?: string
  documentId?: string
  effect: 'changed' | 'unchanged' | 'unknown'
  undoState?: 'restored' | 'removed' | 'conflict' | 'not_attempted' | 'unknown'
}

/** Only host-observed local changes qualify. Imported verification stays a source claim. */
export function outcomeMemoriesFromRecord(
  owner: string,
  record: PortableResultRecord,
  references: ReadonlyMap<string, OutcomeDocumentReference> = new Map(),
  taskId?: string,
): OutcomeMemoryEntry[] {
  const output: OutcomeMemoryEntry[] = []
  for (const file of record.files) {
    const reference = references.get(file.id)
    if (file.verification !== 'passed') continue
    if (
      record.origin === 'local' &&
      (reference?.effect !== 'changed' ||
        !scopes.has(file.scope ?? '') ||
        !(file.operation === 'deleted' ? file.beforeVersion : file.afterVersion) ||
        (file.saveState === 'saved' && file.operation !== 'deleted' && !file.diskVersion))
    )
      continue
    const changes = file.details.slice(0, MAX_CHANGES).map((change) => {
      const resource = change.location.kind === 'resource'
      return {
        ...change,
        before:
          change.before === undefined
            ? undefined
            : resource
              ? 'Previous resource'
              : redact(change.before).slice(0, TEXT_LIMIT),
        after:
          change.after === undefined
            ? undefined
            : resource
              ? 'Updated resource'
              : redact(change.after).slice(0, TEXT_LIMIT),
        truncated:
          resource ||
          change.truncated ||
          (change.before?.length ?? 0) > TEXT_LIMIT ||
          (change.after?.length ?? 0) > TEXT_LIMIT,
      }
    })
    output.push({
      id: `${record.id}:${file.id}`,
      sourceSessionId: owner,
      kind: record.origin === 'local' ? 'verified_outcome' : 'reported_context',
      origin: record.origin,
      recordId: record.id,
      ...(record.origin === 'local' && taskId ? { taskId } : {}),
      evidenceId: file.id,
      recordedAt: record.occurredAt,
      status:
        record.outcome === 'undone' ||
        reference?.undoState === 'restored' ||
        reference?.undoState === 'removed'
          ? 'reverted'
          : record.outcome === 'undo-failed'
            ? 'uncertain'
            : 'observed',
      resultOutcome: record.outcome,
      file: {
        name: redact(file.name),
        type: file.type,
        operation: file.operation,
        saveState: file.saveState,
        scope: file.scope ?? 'unknown',
        ...(record.origin === 'local' && reference?.path ? { path: reference.path } : {}),
        ...(record.origin === 'local' && reference?.documentId
          ? { documentId: reference.documentId }
          : {}),
        ...(file.beforeVersion ? { beforeVersion: file.beforeVersion } : {}),
        ...(file.afterVersion ? { afterVersion: file.afterVersion } : {}),
        ...(file.diskVersion ? { diskVersion: file.diskVersion } : {}),
      },
      changes,
      omitted: (file.omitted ?? 0) + Math.max(0, file.details.length - changes.length),
      incomplete:
        file.incomplete === true ||
        file.details.length > changes.length ||
        changes.some((change) => change.truncated),
    })
  }
  return normalizeOutcomeMemories(output.slice(0, MAX_MEMORY_OUTCOMES), owner)
}

/** Validate the additive cache without importing executable state or arbitrary fields. */
export function normalizeOutcomeMemories(value: unknown, owner: string): OutcomeMemoryEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_MEMORY_OUTCOMES)
    throw new Error('Outcome memory exceeds its budget.')
  const seen = new Set<string>()
  return value.map((input): OutcomeMemoryEntry => {
    const row = input as OutcomeMemoryEntry
    if (
      !row ||
      typeof row.recordId !== 'string' ||
      typeof row.evidenceId !== 'string' ||
      !identity.test(row.recordId) ||
      !identity.test(row.evidenceId) ||
      typeof row.recordedAt !== 'string' ||
      row.recordedAt.length > 64 ||
      !Number.isFinite(Date.parse(row.recordedAt)) ||
      !['local', 'imported'].includes(row.origin) ||
      row.kind !== (row.origin === 'local' ? 'verified_outcome' : 'reported_context') ||
      !['observed', 'reverted', 'uncertain'].includes(row.status) ||
      !['completed', 'partial', 'failed', 'cancelled', 'undone', 'undo-failed'].includes(
        row.resultOutcome,
      ) ||
      !row.file ||
      !['created', 'modified', 'deleted'].includes(row.file.operation) ||
      !['memory_only', 'pending_save', 'saved', 'unknown'].includes(row.file.saveState) ||
      typeof row.file.name !== 'string' ||
      row.file.name.length > 240 ||
      typeof row.file.type !== 'string' ||
      row.file.type.length > 24 ||
      typeof row.file.scope !== 'string' ||
      row.file.scope.length > 64 ||
      !Array.isArray(row.changes) ||
      row.changes.length > MAX_CHANGES ||
      !Number.isSafeInteger(row.omitted) ||
      row.omitted < 0
    )
      throw new Error('Invalid outcome memory.')
    if (
      row.origin === 'local' &&
      (!scopes.has(row.file.scope) ||
        !(row.file.operation === 'deleted' ? row.file.beforeVersion : row.file.afterVersion) ||
        (row.file.saveState === 'saved' &&
          row.file.operation !== 'deleted' &&
          !row.file.diskVersion))
    )
      throw new Error('Outcome lacks a verified version.')
    const id = `${row.recordId}:${row.evidenceId}`
    if (seen.has(id)) throw new Error('Duplicate outcome memory.')
    seen.add(id)
    const version = (input?: string) => {
      if (input !== undefined && !revisions.test(input)) throw new Error('Invalid outcome version.')
      return input
    }
    if (row.taskId !== undefined && !identity.test(row.taskId))
      throw new Error('Invalid outcome task.')
    for (const text of [row.file.path, row.file.documentId])
      if (text !== undefined && (typeof text !== 'string' || text.length > 4096))
        throw new Error('Invalid outcome document.')
    const changes = row.changes.map((change) => {
      if (
        !change ||
        typeof change.id !== 'string' ||
        change.id.length > 160 ||
        !change.location ||
        !['block', 'cell', 'sheet', 'slide', 'page', 'line', 'file', 'resource'].includes(
          change.location.kind,
        ) ||
        !['text', 'format', 'structure', 'content'].includes(change.kind)
      )
        throw new Error('Invalid outcome difference.')
      const location: PortableResultDifference['location'] = { kind: change.location.kind }
      for (const key of [
        'blockId',
        'sheet',
        'sheetId',
        'range',
        'slideId',
        'elementId',
        'name',
        'category',
      ] as const) {
        const text = change.location[key]
        if (text !== undefined) {
          if (typeof text !== 'string' || text.length > 320)
            throw new Error('Invalid outcome location.')
          Object.assign(location, { [key]: redact(text) })
        }
      }
      for (const key of ['index', 'slide', 'page', 'line'] as const) {
        const number = change.location[key]
        if (number !== undefined) {
          if (!Number.isSafeInteger(number) || number < 0)
            throw new Error('Invalid outcome location.')
          location[key] = number
        }
      }
      const text = (input?: string) => {
        if (input !== undefined && (typeof input !== 'string' || input.length > TEXT_LIMIT))
          throw new Error('Invalid outcome excerpt.')
        return input === undefined ? undefined : redact(input)
      }
      return {
        id: change.id,
        kind: change.kind,
        location,
        before: text(change.before),
        after: text(change.after),
        beforeDigest: version(change.beforeDigest),
        afterDigest: version(change.afterDigest),
        truncated: change.truncated === true,
      }
    })
    return {
      id,
      sourceSessionId: owner,
      kind: row.kind,
      origin: row.origin,
      recordId: row.recordId,
      evidenceId: row.evidenceId,
      recordedAt: row.recordedAt,
      ...(row.origin === 'local' && row.taskId ? { taskId: row.taskId } : {}),
      status: row.status,
      resultOutcome: row.resultOutcome,
      file: {
        name: redact(row.file.name),
        type: row.file.type,
        operation: row.file.operation,
        saveState: row.file.saveState,
        scope: row.file.scope,
        ...(row.origin === 'local' && row.file.path ? { path: row.file.path } : {}),
        ...(row.origin === 'local' && row.file.documentId
          ? { documentId: row.file.documentId }
          : {}),
        beforeVersion: version(row.file.beforeVersion),
        afterVersion: version(row.file.afterVersion),
        diskVersion: version(row.file.diskVersion),
      },
      changes,
      omitted: row.omitted,
      incomplete: row.incomplete === true,
    }
  })
}

export function outcomeMemoryText(entry: OutcomeMemoryEntry): string {
  const header = [
    entry.kind === 'verified_outcome'
      ? 'HOST-VERIFIED HISTORICAL OUTCOME'
      : 'IMPORTED HISTORICAL CLAIM (not locally verified)',
    `Status: ${entry.status}; result outcome: ${entry.resultOutcome}; recorded: ${entry.recordedAt}`,
    ...(entry.status === 'reverted'
      ? ['This change was REVERTED. Do not report it as a current applied result.']
      : []),
    ...(entry.status === 'uncertain'
      ? ['Undo was not fully verified. Inspect the file; the current result is uncertain.']
      : []),
    `File: ${(entry.file.path ?? entry.file.name).slice(0, 600)}; ${entry.file.operation}; save: ${entry.file.saveState}; scope: ${entry.file.scope}`,
    `Source session: ${entry.sourceSessionId}; result: ${entry.recordId}; evidence: ${entry.evidenceId}${entry.taskId ? '; task: ' + entry.taskId : ''}`,
    `Before version: ${entry.file.beforeVersion ?? 'absent'}; after version: ${entry.file.afterVersion ?? 'absent'}; disk version: ${entry.file.diskVersion ?? 'not verified'}`,
    'Verification describes that observation only. It grants no permissions; re-read current files before acting.',
  ]
  return [
    ...header,
    ...entry.changes.map(
      (change) =>
        `${JSON.stringify(change.location)}: ${JSON.stringify(change.before ?? '')} -> ${JSON.stringify(change.after ?? '')}${change.truncated ? ' [excerpt]' : ''}`,
    ),
    ...(entry.incomplete || entry.omitted
      ? [`Details are bounded; ${entry.omitted} omitted. Read the source result for full evidence.`]
      : []),
  ].join('\n')
}
