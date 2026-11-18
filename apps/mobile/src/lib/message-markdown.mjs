/** A bounded presentation subset. The output is text data, never HTML, URLs or executable attributes. */
export function parseMessageMarkdown(input, options = {}) {
  const source = typeof input === 'string' ? input : ''
  const maxChars = options.maxChars ?? 100000
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1000000)
    throw new RangeError('Invalid message limit')
  let end = Math.min(source.length, maxChars)
  if (end < source.length && end > 0 && /[\uD800-\uDBFF]/.test(source[end - 1])) end--
  const lines = source.slice(0, end).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let paragraph = []
  let code = null
  let list = null
  let stopped = false
  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push({ kind: 'paragraph', spans: parseMessageInlines(paragraph.join('\n')) })
    paragraph = []
  }
  const flushList = () => {
    if (list) {
      blocks.push(list)
      list = null
    }
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    if (blocks.length >= 1000) {
      stopped = true
      break
    }
    if (code) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === code.fence[0] && close[1].length >= code.fence.length) {
        blocks.push({ kind: 'code', text: code.lines.join('\n'), language: code.language })
        code = null
      } else code.lines.push(line)
      continue
    }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      flushParagraph()
      flushList()
      const language = fence[2].trim()
      code = {
        fence: fence[1],
        lines: [],
        language: /^[a-z0-9_+#.-]{1,32}$/i.test(language) ? language : '',
      }
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const header = tableCells(line)
    const divider = tableCells(lines[lineIndex + 1] || '')
    if (
      header.length >= 2 &&
      header.length <= 20 &&
      divider.length === header.length &&
      divider.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
    ) {
      flushParagraph()
      flushList()
      const rows = []
      lineIndex++
      while (lineIndex + 1 < lines.length && rows.length < 200) {
        const cells = tableCells(lines[lineIndex + 1])
        if (cells.length < 2) break
        rows.push(header.map((_, index) => parseMessageInlines(cells[index] || '')))
        lineIndex++
      }
      blocks.push({ kind: 'table', headers: header.map((cell) => parseMessageInlines(cell)), rows })
      continue
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        spans: parseMessageInlines(heading[2]),
      })
      continue
    }
    const bullet = /^\s{0,3}([-+*]|\d{1,6}[.)])\s+(.+)$/.exec(line)
    if (bullet) {
      flushParagraph()
      const ordered = /^\d/.test(bullet[1])
      if (list && list.ordered !== ordered) flushList()
      list ??= { kind: 'list', ordered, items: [] }
      list.items.push({ marker: ordered ? bullet[1] : '•', spans: parseMessageInlines(bullet[2]) })
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  if (code) blocks.push({ kind: 'code', language: code.language, text: code.lines.join('\n') })
  return { blocks, truncated: end < source.length || stopped }
}

function tableCells(line) {
  if (!line.includes('|')) return []
  const cells = []
  let cell = '',
    fence = 0
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '\\' && line[index + 1] === '|') {
      cell += '|'
      index++
      continue
    }
    if (char === '`') {
      let count = 1
      while (line[index + count] === '`') count++
      fence = fence === count ? 0 : fence || count
      cell += '`'.repeat(count)
      index += count - 1
    } else if (char === '|' && !fence) {
      cells.push(cell.trim())
      cell = ''
    } else cell += char
  }
  cells.push(cell.trim())
  if (line.trimStart().startsWith('|')) cells.shift()
  if (line.trimEnd().endsWith('|')) cells.pop()
  return cells
}

export function parseMessageInlines(text, bold = false, depth = 0) {
  const spans = []
  const push = (value, kind = 'text', strong = bold) => {
    if (!value) return
    // App's JS Service engine may be older than the device's visible WebView.
    const previous = spans[spans.length - 1]
    if (previous?.kind === kind && previous.bold === strong) previous.text += value
    else spans.push({ kind, text: value, bold: strong })
  }
  let cursor = 0
  const markers = /`+|\*\*|__/g
  for (let match; (match = markers.exec(text));) {
    if (match.index < cursor) continue
    const marker = match[0]
    const contentStart = match.index + marker.length
    const close = text.indexOf(marker, contentStart)
    if (close < 0) break
    if (close === contentStart) continue
    push(text.slice(cursor, match.index))
    const value = text.slice(contentStart, close)
    if (marker[0] === '`') push(value.replace(/\n/g, ' '), 'code')
    else if (depth < 2) {
      for (const span of parseMessageInlines(value, true, depth + 1))
        push(span.text, span.kind, true)
    } else push(value, 'text', true)
    cursor = close + marker.length
    markers.lastIndex = cursor
  }
  push(text.slice(cursor))
  return spans
}
