import { useMemo } from 'react'
import { marked, Renderer } from 'marked'
import type { Tokens } from 'marked'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeLink(value: string): string | null {
  const href = String(value ?? '').trim()
  if (!href) return null
  // Keep normal web links and the internal citation schemes used by the
  // Office editors. Everything else (notably javascript: and data:text) is
  // rendered as plain text instead of becoming an active link.
  if (/^(?:https?:|mailto:|#|\/|\.\.?\/|(?:docnav|mdnav):)/iu.test(href)) return href
  return null
}

function safeImage(value: string): string | null {
  const href = String(value ?? '').trim()
  return /^(?:https?:|data:image\/(?:png|jpeg|gif|webp);base64,)/iu.test(href) ? href : null
}

function renderMarkdown(value: string, allowImages = true): string {
  const renderer = new Renderer()
  // Marked deliberately leaves raw HTML enabled for compatibility. Agent
  // output is untrusted, so emit raw HTML as escaped text and constrain links
  // and images to known-safe schemes.
  renderer.html = ({ text }: Tokens.HTML | Tokens.Tag): string => escapeHtml(text)
  renderer.link = function ({ href, title, tokens }: Tokens.Link): string {
    const label = this.parser.parseInline(tokens)
    const safe = safeLink(href)
    if (!safe) return label
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer"${titleAttr}>${label}</a>`
  }
  renderer.image = ({ href, title, text }: Tokens.Image): string => {
    if (!allowImages) return escapeHtml(text)
    const safe = safeImage(href)
    if (!safe) return escapeHtml(text)
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}" loading="lazy"${titleAttr}>`
  }
  const html = marked.parse(value, {
    gfm: true,
    breaks: true,
    async: false,
    renderer,
  })
  return String(html)
}

export function WorkspaceMarkdown({
  value,
  allowImages = true,
}: {
  value: string
  allowImages?: boolean
}) {
  const html = useMemo(() => renderMarkdown(value, allowImages), [value, allowImages])
  return <div className="workspace-chat-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
