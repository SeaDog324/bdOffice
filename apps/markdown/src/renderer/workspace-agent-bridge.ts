import { documentCommandError } from '../../../shell/src/shared/document-tool-contracts'

export type MarkdownWorkspaceCommand = Record<string, unknown>

export interface MarkdownMutation {
  ok: boolean
  changed: number
  description: string
  text: string
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

export function inspectLiveMarkdown(text: string) {
  const lines = text.split(/\r?\n/)
  const blocks = lines.flatMap((line, index) => {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    return heading
      ? [{ id: `line-${index + 1}`, type: `heading-${heading[1]!.length}`, text: heading[2]! }]
      : []
  })
  return {
    title: blocks[0]?.text ?? '',
    textLength: text.length,
    pageEstimate: Math.max(1, Math.ceil(Math.max(1, lines.length) / 40)),
    blocks,
  }
}

export function readLiveMarkdown(
  text: string,
  request: Record<string, unknown> = {},
): { text: string; truncated: boolean } {
  const maxChars = Math.min(Math.max(integer(request.maxChars) ?? 80_000, 1), 500_000)
  const startLine = integer(request.startLine)
  const endLine = integer(request.endLine)
  if (startLine !== undefined || endLine !== undefined) {
    const lines = text.split(/\r?\n/)
    const start = startLine ?? 1
    const end = endLine ?? start
    if (start < 1 || end < start || end > lines.length)
      throw new Error(`Line range must satisfy 1 <= startLine <= endLine <= ${lines.length}.`)
    const selected = lines.slice(start - 1, end).join('\n')
    return { text: selected.slice(0, maxChars), truncated: selected.length > maxChars }
  }
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars }
}

export function searchLiveMarkdown(text: string, query: unknown) {
  const needle = String(query ?? '')
    .trim()
    .toLocaleLowerCase()
  if (!needle) return []
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.toLocaleLowerCase().includes(needle))
    .slice(0, 100)
    .map(({ line, index }) => ({
      line: index + 1,
      preview: line.trim().slice(0, 500),
      location: { line: index + 1 },
    }))
}

/** Same line-oriented semantic contract used by the closed-file session. */
export function mutateLiveMarkdown(
  current: string,
  command: MarkdownWorkspaceCommand,
): MarkdownMutation {
  const invalid = documentCommandError('md', command)
  if (invalid) return { ok: false, changed: 0, description: invalid, text: current }
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const kind =
    typeof command.kind === 'string'
      ? command.kind
      : typeof command.operation === 'string'
        ? command.operation
        : 'replace_text'
  const content =
    typeof command.content === 'string'
      ? command.content
      : typeof command.text === 'string'
        ? command.text
        : ''
  let next = current
  let changed = 0
  if (kind === 'insert' || kind === 'insert_content') {
    const afterLine = integer(command.afterLine) ?? 0
    const lines = current.split(/\r?\n/)
    if (afterLine < 0 || afterLine > lines.length) {
      return {
        ok: false,
        changed: 0,
        description: 'afterLine is outside the document.',
        text: current,
      }
    }
    if (!content) {
      return { ok: false, changed: 0, description: 'Provide Markdown content.', text: current }
    }
    lines.splice(afterLine, 0, ...content.split(/\r?\n/))
    next = lines.join(eol)
    changed = 1
  } else {
    const find =
      typeof command.find === 'string'
        ? command.find
        : typeof command.query === 'string'
          ? command.query
          : ''
    const replacement = typeof command.replace === 'string' ? command.replace : content
    const startLine = integer(command.startLine)
    const endLine = integer(command.endLine)
    if (startLine !== undefined || endLine !== undefined) {
      const lines = current.split(/\r?\n/)
      const start = startLine ?? 1
      const end = endLine ?? start
      if (start > lines.length || end > lines.length) {
        return {
          ok: false,
          changed: 0,
          description: 'Line range is outside the document.',
          text: current,
        }
      }
      lines.splice(start - 1, end - start + 1, ...replacement.split(/\r?\n/))
      next = lines.join(eol)
      changed = 1
    } else if (!find) {
      return {
        ok: false,
        changed: 0,
        description: 'Provide find text or a line range.',
        text: current,
      }
    } else if (command.firstOnly === true) {
      const index = current.indexOf(find)
      if (index >= 0) {
        next = `${current.slice(0, index)}${replacement}${current.slice(index + find.length)}`
        changed = 1
      }
    } else {
      changed = current.split(find).length - 1
      if (changed > 0) next = current.split(find).join(replacement)
    }
  }
  if (changed === 0 || next === current) {
    return { ok: false, changed: 0, description: 'No matching Markdown content.', text: current }
  }
  return {
    ok: true,
    changed,
    description:
      kind === 'insert' || kind === 'insert_content'
        ? 'Inserted Markdown content.'
        : `Updated Markdown (${changed} replacement${changed === 1 ? '' : 's'}).`,
    text: next,
  }
}
