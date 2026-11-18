import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import {
  PORTABLE_ARTIFACT_LIMIT,
  normalizePortableResults,
  type PortableResultArtifact,
  type PortableResultRecord,
  type PortableResults,
} from '@genoffice/project-store'
import type {
  AgentRunFileChange,
  AgentRunReview,
  WorkspaceFileType,
} from '../../shared/workspace-agent-api'
import type { ChangeLocation } from '../../shared/change-evidence'

const documentExtensions = new Set([
  '.docx',
  '.xlsx',
  '.xlsm',
  '.pptx',
  '.pdf',
  '.md',
  '.txt',
  '.html',
  '.csv',
  '.json',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
])
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function filename(path: string): string {
  return (
    (path.split(/[\\/]/).pop() ?? 'document')
      .replace(/[<>:"/\\|?*]/g, '_')
      .split('')
      .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[. ]+$/, '')
      .slice(0, 240) || 'document'
  )
}
export function portableResult(review: AgentRunReview): PortableResultRecord {
  return {
    id: review.id,
    ...(review.taskId ? { taskId: review.taskId } : {}),
    occurredAt: review.completedAt,
    origin: review.historical ? 'imported' : 'local',
    outcome: review.state === 'completed' ? (review.outcome ?? 'completed') : review.state,
    files: review.changes
      .filter(
        (change) =>
          change.evidence?.effect !== 'unchanged' &&
          !(change.operation === 'created' && change.evidence?.effect === 'unknown'),
      )
      .map((change) => ({
        id: change.evidence?.id ?? randomUUID(),
        name: filename(change.path),
        type: change.type,
        operation: change.operation,
        saveState: change.evidence?.saveState ?? 'unknown',
        verification: change.evidence?.verification ?? 'unknown',
        scope: change.evidence?.verificationScope,
        beforeVersion: change.evidence?.beforeVersion,
        afterVersion: change.evidence?.afterVersion,
        diskVersion: change.evidence?.diskVersion,
        details: [...(change.evidence?.details ?? []), ...(change.evidence?.resources ?? [])].slice(
          0,
          100,
        ),
        incomplete: change.evidence?.incomplete ?? true,
        omitted: change.evidence?.omitted,
        artifactId: change.artifactId,
      })),
  }
}
export function importedResult(record: PortableResultRecord): AgentRunReview {
  const state =
    record.outcome === 'undone' || record.outcome === 'undo-failed' ? record.outcome : 'completed'
  return {
    id: record.id,
    startedAt: record.occurredAt,
    completedAt: record.occurredAt,
    state,
    outcome:
      record.outcome === 'undone' || record.outcome === 'undo-failed' ? undefined : record.outcome,
    historical: true,
    evidenceStored: true,
    undoable: false,
    changes: record.files.map((file): AgentRunFileChange => ({
      path: file.name,
      type: file.type as WorkspaceFileType,
      operation: file.operation,
      undoable: false,
      tools: [],
      summaries: [],
      artifactId: file.artifactId,
      evidence: {
        version: 1,
        id: file.id,
        recordedAt: record.occurredAt,
        type: file.type as WorkspaceFileType,
        source: 'document',
        effect: 'changed',
        beforeVersion: file.beforeVersion,
        afterVersion: file.afterVersion,
        diskVersion: file.diskVersion,
        saveState: file.saveState,
        verification: file.verification,
        basis: 'unavailable',
        details: file.details.map((detail) => ({
          ...detail,
          location: detail.location as ChangeLocation,
        })),
        omitted: file.omitted ?? 0,
        incomplete: file.incomplete === true,
      },
    })),
  }
}

/** Copy only a saved artifact whose bytes still match its recorded evidence. */
export async function buildPortableResults(
  reviews: AgentRunReview[],
  resolve: (path: string) => Promise<string>,
  imported?: PortableResults,
): Promise<PortableResults | undefined> {
  if (!reviews.length) return imported
  if (reviews.length > 2_000) throw new Error('Session result history exceeds the transfer limit.')
  const artifacts: PortableResultArtifact[] = [...(imported?.artifacts ?? [])],
    records = [...(imported?.records ?? [])]
  let remaining =
    PORTABLE_ARTIFACT_LIMIT - artifacts.reduce((total, item) => total + item.byteLength, 0)
  for (const review of reviews) {
    const record = portableResult(review)
    for (const [index, file] of record.files.entries()) {
      const change = review.changes[index]!
      delete file.artifactId
      if (
        !file.diskVersion ||
        file.saveState !== 'saved' ||
        file.verification !== 'passed' ||
        change.operation === 'deleted' ||
        review.state !== 'completed' ||
        !documentExtensions.has(extname(file.name).toLowerCase())
      )
        continue
      const existing = artifacts.find(
        (item) => item.sha256 === file.diskVersion && item.name === file.name,
      )
      if (existing) {
        file.artifactId = existing.id
        continue
      }
      try {
        const path = await resolve(change.path),
          info = await stat(path)
        if (!info.isFile() || info.size <= 0 || info.size > remaining || artifacts.length >= 256)
          continue
        const bytes = await readFile(path)
        if (bytes.byteLength !== info.size || hash(bytes) !== file.diskVersion) continue
        const artifact = {
          id: randomUUID(),
          name: basename(file.name),
          sha256: file.diskVersion,
          byteLength: bytes.byteLength,
          base64: bytes.toString('base64'),
        }
        artifacts.push(artifact)
        remaining -= bytes.byteLength
        file.artifactId = artifact.id
      } catch {
        /* The history still transfers when its original file is offline or has changed. */
      }
    }
    records.push(record)
  }
  return normalizePortableResults({ version: 1, records, artifacts })
}
