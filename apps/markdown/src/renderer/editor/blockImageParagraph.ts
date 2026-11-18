import { Paragraph } from '@tiptap/extension-paragraph'
import { Link } from '@tiptap/extension-link'
import type { JSONContent } from '@tiptap/core'

/** The stock Markdown mark applicator visits text only; image links have no
 * text child on which it could retain the destination. */
export const LinkedImageLink = Link.extend({
  parseMarkdown: (token, helpers) => {
    const mark = { type: 'link', attrs: { href: token.href, title: token.title || null } }
    const apply = (nodes: JSONContent[]): JSONContent[] =>
      nodes.map((node) => {
        if (node.type === 'image')
          return {
            ...node,
            attrs: { ...node.attrs, linkHref: token.href, linkTitle: token.title || null },
          }
        if (node.type === 'text') return { ...node, marks: [...(node.marks ?? []), mark] }
        return node.content ? { ...node, content: apply(node.content) } : node
      })
    return apply(helpers.parseInline(token.tokens || []))
  },
})

/** Image nodes are blocks in this editor. The stock parser unwraps only a
 * direct image token, missing images nested in a link/emphasis token. Split
 * parsed inline runs around those images without losing their link attributes. */
export const BlockImageParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const parsed = Paragraph.config.parseMarkdown!(token, helpers) as JSONContent | JSONContent[]
    if (
      Array.isArray(parsed) ||
      parsed.type !== 'paragraph' ||
      !parsed.content?.some((node) => node.type === 'image')
    )
      return parsed
    const blocks: JSONContent[] = []
    let inline: JSONContent[] = []
    const flush = () => {
      if (inline.length) blocks.push({ ...parsed, content: inline })
      inline = []
    }
    for (const node of parsed.content) {
      if (node.type === 'image') {
        flush()
        blocks.push(node)
      } else inline.push(node)
    }
    flush()
    return blocks
  },
})
