/** Replace literal text across adjacent styled runs without flattening their formatting.
 * Replacement text inherits the first matched run. Untouched text keeps its runs.
 * Field runs are barriers: their generated content is never searched or changed.
 */
export function replaceTextInRuns<T extends { text: string; field?: unknown }>(
  runs: T[],
  find: string,
  replacement: string,
  options: { matchCase?: boolean; limit?: number } = {},
): number {
  if (!find || (find === replacement && options.matchCase !== false)) return 0
  const expression = new RegExp(
    find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    options.matchCase === false ? 'gi' : 'g',
  )
  let count = 0
  let start = 0
  while (start < runs.length && count < (options.limit ?? Infinity)) {
    if (runs[start]!.field) {
      start++
      continue
    }
    let end = start
    const spans: { run: T; start: number; end: number }[] = []
    let text = ''
    while (end < runs.length && !runs[end]!.field) {
      const run = runs[end++]!
      spans.push({ run, start: text.length, end: text.length + run.text.length })
      text += run.text
    }
    const matches: { start: number; end: number }[] = []
    for (const match of text.matchAll(expression)) {
      if (count >= (options.limit ?? Infinity)) break
      if (match[0] === replacement) continue
      matches.push({ start: match.index, end: match.index + match[0].length })
      count++
    }
    for (const match of matches.reverse()) {
      const touched = spans.filter((span) => span.end > match.start && span.start < match.end)
      touched.forEach((span, index) => {
        const from = Math.max(0, match.start - span.start)
        const to = Math.min(span.end - span.start, match.end - span.start)
        span.run.text =
          span.run.text.slice(0, from) + (index === 0 ? replacement : '') + span.run.text.slice(to)
      })
    }
    start = end
  }
  return count
}
