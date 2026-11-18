import type { EditSnapshot } from './edit-state'
import type { MarkupType } from '../shared/ipc'
import { documentCommandError } from '../../../shell/src/shared/document-tool-contracts'

type JsonRecord = Record<string, unknown>

/** Translate the Agent's current, visible 1-based page to the editor's original index. */
export function originalPageIndexForVisible(
  visibleOrder: readonly number[],
  page: unknown,
): number | null {
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null
  return visibleOrder[page - 1] ?? null
}

export function visiblePageNumberForOriginal(
  visibleOrder: readonly number[],
  originalPage: number,
): number | null {
  const index = visibleOrder.indexOf(originalPage - 1)
  return index < 0 ? null : index + 1
}

export type NormalizedPdfAnnotation =
  | {
      kind: 'note'
      pageIndex: number
      at: [number, number]
      contents: string
    }
  | {
      kind: 'markup'
      pageIndex: number
      type: MarkupType
      rects: [number, number, number, number][]
      color?: [number, number, number]
    }

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function color(value: unknown): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value ?? '').trim())
  if (!match) return undefined
  const rgb = Number.parseInt(match[1]!, 16)
  return [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255]
}

function rect(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return null
  const numbers = value as number[]
  if (numbers[2]! <= numbers[0]! || numbers[3]! <= numbers[1]!) return null
  return [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!]
}

function quadRect(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 8 || !value.every(Number.isFinite)) return null
  const xs = [value[0], value[2], value[4], value[6]] as number[]
  const ys = [value[1], value[3], value[5], value[7]] as number[]
  return rect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
}

export function normalizePdfAnnotation(
  command: JsonRecord,
  pageCount: number,
  readOnly: boolean,
  isDeleted: (pageIndex: number) => boolean,
): NormalizedPdfAnnotation | { error: string } {
  const invalid = documentCommandError('pdf', { kind: 'pdf_annotate', ...command })
  if (invalid) return { error: invalid }
  if (readOnly) return { error: 'The PDF is read-only.' }
  const page = command.page
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount)
    return { error: `Page must be between 1 and ${pageCount}.` }
  const pageIndex = page - 1
  if (isDeleted(pageIndex)) return { error: `Page ${page} has been deleted.` }
  const type = typeof command.type === 'string' ? command.type : 'highlight'
  if (command.color !== undefined && !color(command.color))
    return { error: 'color must be #RRGGBB.' }
  if (['x', 'y'].some((key) => command[key] !== undefined && !Number.isFinite(command[key])))
    return { error: 'Note coordinates must be finite numbers.' }
  if (type === 'note') {
    const contents = String(command.contents ?? command.text ?? '').trim()
    if (!contents) return { error: 'Provide note contents.' }
    return {
      kind: 'note',
      pageIndex,
      at: [finite(command.x, 18), finite(command.y, 18)],
      contents,
    }
  }
  if (type !== 'highlight' && type !== 'underline' && type !== 'strikeout')
    return { error: 'Unsupported PDF annotation type.' }
  if (command.quads !== undefined && command.rect !== undefined)
    return { error: 'Choose quads or rect, not both.' }
  if (command.rect !== undefined && !rect(command.rect))
    return { error: 'rect must contain finite x0,y0,x1,y1 with x1 > x0 and y1 > y0.' }
  if (
    command.quads !== undefined &&
    (!Array.isArray(command.quads) ||
      !command.quads.length ||
      command.quads.some((quad) => !quadRect(quad)))
  )
    return { error: 'Every quad must contain eight finite coordinates and have nonzero area.' }
  const rects: [number, number, number, number][] = Array.isArray(command.quads)
    ? command.quads
        .map(quadRect)
        .filter((value): value is [number, number, number, number] => value !== null)
    : []
  const explicit = rect(command.rect)
  if (explicit) rects.push(explicit)
  if (!rects.length) return { error: 'Provide PDF quads or a rect for the annotation.' }
  return { kind: 'markup', pageIndex, type, rects, color: color(command.color) }
}

/** Convert Map/Set fields so the snapshot survives Electron and JSON persistence. */
export function serializePdfEditSnapshot(snapshot: EditSnapshot): JsonRecord {
  return {
    ...snapshot,
    formEdits: [...snapshot.formEdits.entries()],
    formWidgetEdits: [...(snapshot.formWidgetEdits?.entries() ?? [])],
    rotations: [...snapshot.rotations.entries()],
    deleted: [...snapshot.deleted.values()],
  }
}

export function deserializePdfEditSnapshot(value: unknown): EditSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as JsonRecord
  const arrayFields = [
    'markups',
    'annotDeletes',
    'noteEdits',
    'drawings',
    'textEdits',
    'textInserts',
    'imageEdits',
    'formEdits',
    'rotations',
    'deleted',
  ]
  if (arrayFields.some((key) => !Array.isArray(record[key]))) return null
  if (record.order !== null && !Array.isArray(record.order)) return null
  return {
    markups: record.markups as EditSnapshot['markups'],
    annotDeletes: record.annotDeletes as EditSnapshot['annotDeletes'],
    noteEdits: record.noteEdits as EditSnapshot['noteEdits'],
    drawings: record.drawings as EditSnapshot['drawings'],
    textEdits: record.textEdits as EditSnapshot['textEdits'],
    textInserts: record.textInserts as EditSnapshot['textInserts'],
    imageEdits: record.imageEdits as EditSnapshot['imageEdits'],
    formFields: Array.isArray(record.formFields)
      ? (record.formFields as EditSnapshot['formFields'])
      : [],
    formWidgetEdits: new Map(Array.isArray(record.formWidgetEdits) ? record.formWidgetEdits : []),
    blankPages: Array.isArray(record.blankPages)
      ? (record.blankPages as EditSnapshot['blankPages'])
      : [],
    stampCfg: (record.stampCfg ?? null) as EditSnapshot['stampCfg'],
    formEdits: new Map(
      record.formEdits as Array<
        [string, EditSnapshot['formEdits'] extends Map<string, infer V> ? V : never]
      >,
    ),
    rotations: new Map(record.rotations as Array<[number, number]>),
    deleted: new Set(record.deleted as number[]),
    order: record.order as number[] | null,
    metadata: (record.metadata ?? null) as EditSnapshot['metadata'],
  }
}
