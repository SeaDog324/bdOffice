import type { WorkspaceFileEntry, WorkspaceFileType } from '../../shared/workspace-agent-api'

export type ChatReferenceFile = Pick<WorkspaceFileEntry, 'path' | 'name' | 'type'> & {
  directory?: boolean
}

/** Match physical attachments to relative workspace entries without copying files. */
export function referencePathKey(path: string, root = ''): string {
  let full = path.replace(/\\/g, '/')
  if (!/^(?:[a-z]:\/|\/)/i.test(full)) full = `${root.replace(/\\/g, '/')}/${full}`
  full = full.replace(/\/\.\//g, '/').replace(/\/$/, '')
  return /^(?:[a-z]:\/|\/\/)/i.test(full) ? full.toLowerCase() : full
}

export function sessionReferenceFiles(paths: readonly string[]): ChatReferenceFile[] {
  const types: WorkspaceFileType[] = [
    'docx',
    'pptx',
    'xlsx',
    'xlsm',
    'pdf',
    'txt',
    'md',
    'html',
    'csv',
    'json',
    'png',
    'jpg',
    'jpeg',
    'webp',
  ]
  return paths.map((path) => {
    const name = path.split(/[\\/]/).pop() || path
    const extension = name.split('.').pop()?.toLowerCase() as WorkspaceFileType
    return { path, name, type: types.includes(extension) ? extension : 'unknown' }
  })
}

export function mergeReferenceFiles(
  workspaceFiles: ChatReferenceFile[],
  references: ChatReferenceFile[],
  root = '',
): ChatReferenceFile[] {
  const files = new Map(workspaceFiles.map((file) => [referencePathKey(file.path, root), file]))
  for (const reference of references) files.set(referencePathKey(reference.path, root), reference)
  return [...files.values()]
}

/** A filename prefix must not silently select a different file or a built-in context. */
export function fileMentionPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(^|[\\s(（"“'‘])@${escaped}(?=$|[\\s)）"”'’!,;:?，。；：！？]|\\.(?:\\s|$))`,
    'gu',
  )
}

function fileMentionSpans(text: string, labels: string[]) {
  const ranges: Array<{ label: string; start: number; end: number }> = []
  for (const label of [...new Set(labels)].sort((left, right) => right.length - left.length)) {
    for (const match of text.matchAll(fileMentionPattern(label))) {
      const start = match.index! + match[1]!.length,
        end = start + label.length + 1
      if (ranges.some((range) => start < range.end && end > range.start)) continue
      ranges.push({ label, start, end })
    }
  }
  return ranges
}

export function matchedFileMentions(text: string, labels: string[]): Set<string> {
  return new Set(fileMentionSpans(text, labels).map((range) => range.label))
}

interface FileMention {
  label: string
  path?: string
  kind: string
}

function mentionLabels(candidates: FileMention[]) {
  return candidates.flatMap((candidate) =>
    candidate.kind === 'file' && candidate.path
      ? [candidate.label, candidate.path]
      : [candidate.label],
  )
}

function rewriteMentions(
  text: string,
  candidates: FileMention[],
  replacements: Map<string, string>,
) {
  for (const span of fileMentionSpans(text, mentionLabels(candidates)).sort(
    (a, b) => b.start - a.start,
  )) {
    const replacement = replacements.get(span.label)
    if (replacement !== undefined)
      text = text.slice(0, span.start) + replacement + text.slice(span.end)
  }
  return text
}

export function removeFileMention(draft: string, path: string, candidates: FileMention[]): string {
  const candidate = candidates.find((item) => item.kind === 'file' && item.path === path)
  return candidate
    ? rewriteMentions(
        draft,
        candidates,
        new Map([
          [candidate.label, ''],
          [path, ''],
        ]),
      )
    : draft
}

export function appendFileMentions(
  draft: string,
  paths: readonly string[],
  previous: FileMention[],
  next: FileMention[],
  root = '',
): string {
  const replacements = new Map<string, string>()
  const candidates = next.filter((candidate) => candidate.kind === 'file' && candidate.path)
  // Adding a second file with the same basename must preserve the old draft's target.
  for (const old of previous.filter((candidate) => candidate.kind === 'file' && candidate.path)) {
    const current = candidates.find(
      (candidate) => referencePathKey(candidate.path!, root) === referencePathKey(old.path!, root),
    )
    if (current && current.label !== old.label) replacements.set(old.label, `@${current.label}`)
  }
  let text = rewriteMentions(draft, previous, replacements)
  const matched = matchedFileMentions(text, mentionLabels(next))
  for (const path of paths) {
    const candidate = candidates.find(
      (item) => referencePathKey(item.path!, root) === referencePathKey(path, root),
    )
    if (candidate && !matched.has(candidate.label) && !matched.has(candidate.path!)) {
      text += `${text && !/\s$/u.test(text) ? ' ' : ''}@${candidate.label} `
      matched.add(candidate.label)
    }
  }
  return text
}
