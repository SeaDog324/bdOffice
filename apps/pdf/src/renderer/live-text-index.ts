import type { TextEditInput, TextInsertInput } from '../shared/ipc'
import type { PageEntry, SearchIndex } from './search'
import { isScannedText } from './ocr-layer'

type Item = PageEntry['items'][number]
type Rect = TextEditInput['rect']

function spanRect(item: Item, start: number, end: number): Rect {
  const length = item.end - item.start
  return [
    item.x + (item.w * (start - item.start)) / length,
    item.y,
    item.x + (item.w * (end - item.start)) / length,
    item.y + item.h,
  ]
}

function overlap(a: Rect, b: Rect): number {
  return (
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  )
}

/** Normalize once per edited page, not once per pending edit. */
function normalizePageText(text: string): { offsets: number[]; compact: string } {
  const offsets: number[] = []
  let compact = ''
  for (let i = 0; i < text.length; i++) {
    if (/\s/u.test(text[i]!)) continue
    offsets.push(i)
    compact += text[i]
  }
  return { offsets, compact }
}

/** Match the original edit key by text AND geometry, never the first string
 * occurrence on a page. Whitespace tolerance mirrors the save-time contract. */
function editRange(
  page: PageEntry,
  edit: TextEditInput,
  { offsets, compact }: ReturnType<typeof normalizePageText>,
): [number, number] {
  const needle = edit.oldText.replace(/\s/gu, '')
  if (!needle)
    throw new Error('Pending PDF text has no original match key; save before reading it with AI.')
  const candidates: { start: number; end: number; score: number }[] = []
  for (let pos = compact.indexOf(needle); pos >= 0; pos = compact.indexOf(needle, pos + 1)) {
    const start = offsets[pos]!
    const end = offsets[pos + needle.length - 1]! + 1
    const score = page.items.reduce((sum, item) => {
      const lo = Math.max(start, item.start),
        hi = Math.min(end, item.end)
      return hi > lo ? sum + overlap(spanRect(item, lo, hi), edit.rect) : sum
    }, 0)
    if (score > 0) candidates.push({ start, end, score })
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (!best || (candidates[1] && Math.abs(best.score - candidates[1].score) < 0.001)) {
    throw new Error(
      'Pending PDF text cannot be matched unambiguously to its original position; save before reading it with AI.',
    )
  }
  return [best.start, best.end]
}

/** Read/search projection only. Never use its approximate replacement boxes as
 * save-time edit keys. All offsets remain valid and the cached PDF index is immutable. */
export function projectLiveTextIndex(
  source: SearchIndex,
  edits: readonly TextEditInput[],
  inserts: readonly TextInsertInput[],
  deleted: ReadonlySet<number>,
  ocr: (pageIndex: number) => PageEntry | undefined = () => undefined,
): SearchIndex {
  const editsByPage = new Map<number, TextEditInput[]>()
  const insertsByPage = new Map<number, TextInsertInput[]>()
  for (const edit of edits) {
    const page = editsByPage.get(edit.pageIndex)
    if (page) page.push(edit)
    else editsByPage.set(edit.pageIndex, [edit])
  }
  for (const insert of inserts) {
    const page = insertsByPage.get(insert.pageIndex)
    if (page) page.push(insert)
    else insertsByPage.set(insert.pageIndex, [insert])
  }
  return source.map((original, pageIndex) => {
    if (deleted.has(pageIndex)) return { text: '', lower: '', items: [] }
    const base = isScannedText(original.text) ? (ocr(pageIndex) ?? original) : original
    const pageEdits = editsByPage.get(pageIndex) ?? []
    const pageInserts = insertsByPage.get(pageIndex) ?? []
    // The search index is read-only. Preserve untouched page/item identity;
    // rebuilding thousands of boxes here adds no information to an AI read.
    if (!pageEdits.length && !pageInserts.length) return base
    const normalized = pageEdits.length
      ? normalizePageText(base.text)
      : { offsets: [], compact: '' }
    const replacements = pageEdits
      .map((edit) => {
        const [start, end] = editRange(base, edit, normalized)
        return { start, end, edit }
      })
      .sort((a, b) => a.start - b.start)
    let text = ''
    const items: Item[] = []
    const appendOriginal = (start: number, end: number) => {
      const offset = text.length - start
      text += base.text.slice(start, end)
      for (const item of base.items) {
        const lo = Math.max(start, item.start),
          hi = Math.min(end, item.end)
        if (hi <= lo) continue
        const box = spanRect(item, lo, hi)
        items.push({ ...item, start: lo + offset, end: hi + offset, x: box[0], w: box[2] - box[0] })
      }
    }
    const appendText = (value: string, rect: Rect) => {
      if (!value) return
      items.push({
        start: text.length,
        end: text.length + value.length,
        x: rect[0],
        y: rect[1],
        w: Math.max(1, rect[2] - rect[0]),
        h: Math.max(1, rect[3] - rect[1]),
      })
      text += value
    }
    let from = 0
    for (const { start, end, edit } of replacements) {
      if (start < from)
        throw new Error('Pending PDF text edits overlap; save before reading it with AI.')
      appendOriginal(from, start)
      const dx = edit.translate?.[0] ?? (edit.origin ? edit.origin[0] - edit.rect[0] : 0)
      const dy = edit.translate?.[1] ?? (edit.origin ? edit.origin[1] - edit.rect[1] : 0)
      appendText(edit.newText, [
        edit.rect[0] + dx,
        edit.rect[1] + dy,
        edit.rect[2] + dx,
        edit.rect[3] + dy,
      ])
      from = end
    }
    appendOriginal(from, base.text.length)
    for (const insert of pageInserts) {
      text += '\n'
      appendText(insert.text, [
        insert.origin[0],
        insert.origin[1],
        insert.origin[0] + Math.max(1, insert.text.length * insert.fontSize * 0.5),
        insert.origin[1] + insert.fontSize,
      ])
    }
    return { text, lower: text.toLowerCase(), items }
  })
}
