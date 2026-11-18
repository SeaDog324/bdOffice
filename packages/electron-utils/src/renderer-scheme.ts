import type { CustomScheme } from 'electron'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Origin the built renderers are served from (`genoffice-app://<module>/index.html`). */
export const RENDERER_SCHEME = 'genoffice-app'

/** Chromium persists V8 code caches only for http(s) and for privileged custom
 * schemes; a file:// renderer recompiled its whole bundle on every open. */
export const RENDERER_SCHEME_PRIVILEGE: CustomScheme = {
  scheme: RENDERER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}

/** docs' lazily served pictures (packages/docx-engine/src/lazy-media.ts); a
 * secure page may only load pictures from another secure scheme */
export const DOCX_MEDIA_SCHEME_PRIVILEGE: CustomScheme = {
  scheme: 'genoffice-docx-media',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}

/** Slides serves archive pictures outside structured-clone IPC payloads. */
export const SLIDE_MEDIA_SCHEME_PRIVILEGE: CustomScheme = {
  scheme: 'genoffice-slide-media',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}

export type RendererHost = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html' | 'help'

export const MAX_RENDERER_QUERY_ENTRIES = 20
export const MAX_RENDERER_QUERY_CHARS = 4_000

/** Dev server URL when one is configured, otherwise the module's scheme URL; the
 * query is appended either way so a dev URL that already carries params stays valid. */
export function rendererUrl(
  devUrl: string | undefined,
  host: RendererHost,
  query?: Record<string, string>,
  legacyFile?: string,
): string {
  // Keep interactive origins/preferences; only the headless profile uses the scheme.
  let url: URL
  try {
    url = new URL(
      devUrl ??
        (legacyFile ? pathToFileURL(legacyFile).href : `${RENDERER_SCHEME}://${host}/index.html`),
    )
  } catch {
    throw new Error(`Invalid dev URL for renderer "${host}": "${devUrl}"`)
  }
  const entries = Object.entries(query ?? {})
  if (entries.length > MAX_RENDERER_QUERY_ENTRIES) {
    throw new Error(
      `Too many renderer query params (${entries.length}, cap ${MAX_RENDERER_QUERY_ENTRIES})`,
    )
  }
  for (const [key, value] of entries) {
    if (key.length > 256 || value.length > MAX_RENDERER_QUERY_CHARS) {
      throw new Error('Renderer query param too long')
    }
    url.searchParams.set(key, value)
  }
  return url.toString()
}

/** Map a scheme request onto a file under the host's renderer directory; null
 * for unknown hosts and for paths that escape the directory. */
export function resolveRendererFile(
  roots: ReadonlyMap<string, string>,
  requestUrl: string,
): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.username || url.password || url.port)
    return null
  const configuredRoot = roots.get(url.hostname)
  if (!configuredRoot) return null
  const root = resolve(configuredRoot)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.length > 4096 || pathname.includes('\0')) return null
  // Reject Windows separators consistently on every platform.
  if (pathname.includes('\\')) return null
  const file = resolve(root, pathname.replace(/^\/+/, ''))
  // The normalized root is a directory, never a file to serve.
  return file !== root && file.startsWith(root + sep) ? file : null
}
