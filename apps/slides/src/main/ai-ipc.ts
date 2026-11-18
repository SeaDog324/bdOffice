/**
 * AI IPC for the slides main process, extracted from slides-main.ts:
 * settings persistence, the streaming proxy (main process does the networking
 * to avoid renderer CORS), search tools, and the slides-only ai:* channels
 * (image generation, style templates).
 */
import { app, ipcMain, nativeImage, net } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  AiCreditsError,
  AiTimeoutError,
  isAiNetworkError,
  isAiOverloadedError,
  defaultAiSettings,
  activeProvider,
  generateImageForSettings,
  maxOutputTokensOf,
  resolveAiSettings,
  setAiUserAgent,
  setRescueFetch,
  streamForProvider,
  type AiSettings,
  type AiStreamChunk,
  type AiStreamRequest,
  type LegacyAiSettings,
} from '@genoffice/ai-provider'
import { fetchRemoteImage, restrictFileToOwner, writeJsonAtomic } from '@genoffice/electron-utils'
import {
  webSearchTool,
  imageSearchTool,
  generateImageTool,
  analyzeMediaTool,
} from '@genoffice/ai-search'
import { addPicture, editPictureSrcRect, replacePictureBytes } from '@genoffice/pptx-engine'
import { matchesElementRef } from '@genoffice/pptx-engine/identity'
import { coverCropFractions } from '../shared/cover-crop'
import type { AiRunFailure } from '../shared/ipc'
import { EMU_PER_PX_96 } from '@genoffice/pptx-render'
import { tm } from './i18n-main'
import { pushHistory, rebuildSlide, scheduleHistoryNotify, sessions } from './session-state'

// ---- AI settings + streaming proxy (the main process does the networking to avoid renderer CORS; implementation shared via @genoffice/ai-provider) ----

const AI_SETTINGS_PATH = () => join(app.getPath('userData'), 'ai-settings.json')

// Bound inline image payloads before constructing a Response/Buffer. Hosted
// URLs continue through fetchRemoteImage, whose redirect hops are SSRF-checked.
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024

/** Read an untrusted remote image response without buffering past the insert limit. */
export async function readImageResponseLimited(response: Response): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_REMOTE_IMAGE_BYTES) return null
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_REMOTE_IMAGE_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export function responseForImageUrl(url: string): Response | null {
  if (url.length > 28_000_000) return null
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url)
  if (!match) return null
  const mime = match[1]!.toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) return null
  try {
    const base64 = match[2]!.replace(/\s/g, '')
    if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
      return null
    if (Buffer.byteLength(base64, 'base64') > MAX_INLINE_IMAGE_BYTES) return null
    return new Response(Buffer.from(base64, 'base64'), {
      status: 200,
      headers: { 'content-type': mime },
    })
  } catch {
    return null
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    /* Corrupted state file: fall back to defaults */
  }
  return fallback
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

const activeAiStreams = new Map<string, AbortController>()
let aiIpcRegistered = false
let slidesOnlyAiIpcRegistered = false

function aiStreamKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`
}

// ---- Post-mortem log for runs that produced no usable reply ----

const AI_RUN_FAILURES_PATH = () => join(app.getPath('userData'), 'ai-run-failures.jsonl')
/** Enough of a repetition blowup to recognize the pattern, without storing megabytes */
const RUN_FAILURE_TEXT_MAX = 20_000
/** Rotated (one generation kept) rather than grown without bound */
const RUN_FAILURES_MAX_BYTES = 2_000_000

function appendRunFailure(entry: AiRunFailure): void {
  const path = AI_RUN_FAILURES_PATH()
  try {
    if (existsSync(path) && statSync(path).size > RUN_FAILURES_MAX_BYTES) {
      renameSync(path, `${path}.1`)
    }
    const record = {
      ts: new Date().toISOString(),
      ...entry,
      instruction: entry.instruction.slice(0, RUN_FAILURE_TEXT_MAX),
      streamed: entry.streamed.slice(0, RUN_FAILURE_TEXT_MAX),
      streamedChars: entry.streamed.length,
    }
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    /* Diagnostics must never break a run */
  }
}

export function registerAiIpc(): void {
  if (aiIpcRegistered) return
  aiIpcRegistered = true

  // Node fetch (undici) direct connections get reset under VPN/tun setups; retry over Chromium's stack
  setRescueFetch((url, init) => net.fetch(url, init))
  setAiUserAgent(`GenOffice/${app.getVersion()}`)

  ipcMain.handle('ai:get-settings', (): AiSettings => {
    restrictFileToOwner(AI_SETTINGS_PATH())
    const stored = readJson<Partial<AiSettings> & LegacyAiSettings>(AI_SETTINGS_PATH(), {})
    const settings = resolveAiSettings(stored, defaultAiSettings())
    // Normalize persisted settings and retire any historical Genspark selection.
    settings.provider = activeProvider(settings)
    return settings
  })

  ipcMain.handle('ai:set-settings', (_event, settings: AiSettings) => {
    writeJsonAtomic(AI_SETTINGS_PATH(), settings, 0o600)
  })

  ipcMain.handle('ai:log-run-failure', (_event, entry: AiRunFailure) => {
    appendRunFailure(entry)
  })

  ipcMain.handle('ai:stream', async (event, request: AiStreamRequest) => {
    const { requestId, settings, system, messages } = request
    const tools = request.tools ?? []
    const resolvedSettings = resolveAiSettings(settings, defaultAiSettings())
    const maxTokens = request.maxTokens ?? maxOutputTokensOf(resolvedSettings)
    const provider = activeProvider(resolvedSettings)
    const config = resolvedSettings.providers[provider]
    const send = (chunk: AiStreamChunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream-chunk', chunk)
    }
    if (!config || (provider !== 'codex' && !config.apiKey)) {
      send({
        requestId,
        type: 'error',
        error: tm('errNoApiKey', { provider }),
      })
      return
    }
    if (provider !== 'codex' && !config.model) {
      send({ requestId, type: 'error', error: tm('errNoModel') })
      return
    }
    const key = aiStreamKey(event.sender.id, requestId)
    activeAiStreams.get(key)?.abort()
    const controller = new AbortController()
    activeAiStreams.set(key, controller)
    // wire-activity keepalive: lets the renderer's silence watchdog tell a slow turn from a dead one
    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < 5_000) return
      lastPing = now
      send({ requestId, type: 'ping' })
    }
    try {
      let stopReason: string | undefined
      await streamForProvider(provider, config, system, messages, tools, maxTokens, {
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        signal: controller.signal,
        onDelta: (text) => send({ requestId, type: 'delta', text }),
        onUsage: (usage) => send({ requestId, type: 'usage', usage }),
        onReasoningDelta: (text) => send({ requestId, type: 'reasoning', text }),
        onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
        onActivity: ping,
        onStopReason: (reason) => {
          stopReason = reason
        },
      })
      send(
        stopReason === undefined
          ? { requestId, type: 'done' }
          : { requestId, type: 'done', stopReason },
      )
    } catch (err) {
      if (controller.signal.aborted) {
        send({ requestId, type: 'done' })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ai-stream] ${requestId} (${provider}/${config.model}) failed:`, msg)
        send({
          requestId,
          type: 'error',
          error: msg,
          ...(err instanceof AiTimeoutError
            ? { errorCode: 'timeout' as const }
            : err instanceof AiCreditsError
              ? { errorCode: 'credits' as const }
              : isAiNetworkError(err)
                ? { errorCode: 'network' as const }
                : isAiOverloadedError(err)
                  ? { errorCode: 'overloaded' as const }
                  : {}),
        })
      }
    } finally {
      if (activeAiStreams.get(key) === controller) activeAiStreams.delete(key)
    }
  })

  ipcMain.handle('ai:stream-cancel', (event, requestId: string) => {
    activeAiStreams.get(aiStreamKey(event.sender.id, requestId))?.abort()
  })

  // Search tools (content + images), Serper with DuckDuckGo fallback
  ipcMain.handle('ai:web-search', async (_event, query: string, maxResults?: number) => {
    try {
      return await webSearchTool(
        AI_SETTINGS_PATH(),
        String(query),
        typeof maxResults === 'number' ? maxResults : 6,
      )
    } catch (err) {
      return { results: [], method: 'error', error: String(err) }
    }
  })

  ipcMain.handle('ai:image-search', async (_event, query: string, maxResults?: number) => {
    try {
      return await imageSearchTool(
        AI_SETTINGS_PATH(),
        String(query),
        typeof maxResults === 'number' ? maxResults : 8,
      )
    } catch (err) {
      return { images: [], method: 'error', error: String(err) }
    }
  })
}

// ── ai:* handlers unique to slides ──────────────────────────────────────
// Must be registered inside registerSlidesIpc (not registerAiIpc): in shell aggregate mode the
// generic ai:* channels are registered by docs-main.registerAiIpc, and slides' registerAiIpc is
// never called; docs does not have these channels, so putting them in the wrong place raises
// "No handler registered".
export function registerSlidesOnlyAiIpc(): void {
  if (slidesOnlyAiIpcRegistered) return
  slidesOnlyAiIpcRegistered = true

  // Image generation uses its own vendor configuration, not the chat provider.
  ipcMain.handle(
    'ai:generate-image',
    async (
      _event,
      op: {
        prompt?: unknown
        model?: unknown
        aspectRatio?: unknown
        size?: unknown
        imageSize?: unknown
        referenceImageUrls?: unknown
        transparentBackground?: unknown
      },
    ) => {
      const prompt = String(op?.prompt ?? '').trim()
      if (!prompt) return { error: 'prompt must not be empty' }
      if (op.referenceImageUrls !== undefined && !Array.isArray(op.referenceImageUrls))
        return { error: 'referenceImageUrls must be an array' }
      if (
        !(op.referenceImageUrls as unknown[] | undefined)?.length &&
        op.transparentBackground !== true
      ) {
        const settings = resolveAiSettings(
          readJson<Partial<AiSettings> & LegacyAiSettings>(AI_SETTINGS_PATH(), {}),
          defaultAiSettings(),
        )
        return generateImageForSettings(settings, prompt, {
          ...(op.model ? { model: String(op.model) } : {}),
          ...(op.size || op.imageSize ? { size: String(op.size || op.imageSize) } : {}),
          ...(op.aspectRatio ? { aspectRatio: String(op.aspectRatio) } : {}),
        })
      }
      return generateImageTool(
        AI_SETTINGS_PATH(),
        {
          prompt: String(op?.prompt ?? ''),
          model: op?.model ? String(op.model) : undefined,
          referenceImageUrls: Array.isArray(op?.referenceImageUrls)
            ? op.referenceImageUrls.map(String)
            : undefined,
          aspectRatio: op?.aspectRatio ? String(op.aspectRatio) : undefined,
          imageSize: op?.imageSize ? String(op.imageSize) : undefined,
          size: op?.size ? String(op.size) : undefined,
          transparentBackground: op?.transparentBackground === true,
        },
        { allowGsk: false },
      )
    },
  )

  ipcMain.handle(
    'ai:analyze-media',
    async (_event, op: { mediaUrls: string[]; requirements: string }) => {
      return analyzeMediaTool(
        AI_SETTINGS_PATH(),
        {
          mediaUrls: (op?.mediaUrls ?? []).map(String),
          requirements: String(op?.requirements ?? ''),
        },
        { allowGsk: false },
      )
    },
  )

  /** Bytes of a user attachment the renderer resolved (attachment://): keep
   *  pptx-native formats as-is, convert anything else (webp/bmp/…) to PNG. */
  const attachmentImageBytes = (
    base64: string,
    ext: string,
  ): { buf: Buffer; ext: string } | null => {
    const raw = String(base64).replace(/\s/g, '')
    if (
      raw.length > 28_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)
    )
      return null
    if (Buffer.byteLength(raw, 'base64') > MAX_INLINE_IMAGE_BYTES) return null
    const buf = Buffer.from(raw, 'base64')
    if (!buf.length) return null
    const norm = String(ext)
      .toLowerCase()
      .replace(/^jpeg$/, 'jpg')
    if (norm === 'png' || norm === 'gif' || norm === 'jpg') return { buf, ext: norm }
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return null
    return { buf: img.toPNG(), ext: 'png' }
  }

  // Download an image from a URL and insert it into the given page (image search -> insert in one step; download in the main process avoids CORS)
  ipcMain.handle(
    'ai:insert-image-url',
    async (
      e,
      op: {
        slideIndex: number
        url?: string
        /** raw base64 of a user attachment (attachment:// reference) — no network fetch */
        base64?: string
        ext?: string
        xPx: number
        yPx: number
        wPx: number
        hPx: number
        fitWidthPx: number
      },
    ) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const slide = session.opened.deck.slides[op.slideIndex]
      if (!slide) return null
      try {
        let buf: Buffer
        let ext: string
        if (op.base64 != null) {
          const decoded = attachmentImageBytes(op.base64, op.ext ?? '')
          if (!decoded) return null
          ;({ buf, ext } = decoded)
        } else {
          // the URL originates from AI tool calls (prompt-injectable via image
          // search results), so refuse non-http schemes and private/link-local
          // targets; redirects are followed manually so every hop is validated.
          // fetchRemoteImage adds CDN-friendly headers and transient-error retries.
          const imageUrl = String(op.url)
          const resp = responseForImageUrl(imageUrl) ?? (await fetchRemoteImage(imageUrl))
          if (!resp || !resp.ok) return null
          const bytes = await readImageResponseLimited(resp)
          if (!bytes) return null
          buf = bytes
          const ct = resp.headers.get('content-type') ?? ''
          ext = ct.includes('png')
            ? 'png'
            : ct.includes('gif')
              ? 'gif'
              : ct.includes('webp')
                ? 'webp'
                : 'jpg'
        }
        const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
        const scale = op.fitWidthPx / baseWidthPx
        const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
        pushHistory(session)
        const el = addPicture(session.opened, slide, {
          bytes: new Uint8Array(buf),
          ext,
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: Math.max(1, toEmu(op.wPx)),
            cy: Math.max(1, toEmu(op.hPx)),
          },
        })
        if (!el) {
          session.undoStack.pop()
          scheduleHistoryNotify(session)
          return null
        }
        // The requested frame rarely matches the image's aspect ratio; never
        // stretch — fill the frame and center-crop the overflow (object-fit:
        // cover) so the layout box stays exactly where the model placed it.
        const natural = nativeImage.createFromBuffer(buf).getSize()
        const crop = coverCropFractions(natural.width, natural.height, op.wPx, op.hPx)
        if (crop) editPictureSrcRect(slide, el.id, crop)
        session.fitWidthPx = op.fitWidthPx
        const rebuilt = rebuildSlide(session, op.slideIndex)
        return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
      } catch {
        return null
      }
    },
  )

  // Download an image from a URL and swap it into an existing picture in place
  // (frame/z-order/effects survive). Same URL hardening as ai:insert-image-url.
  ipcMain.handle(
    'ai:replace-picture-url',
    async (
      e,
      op: {
        slideIndex: number
        sourceId: string
        url?: string
        /** raw base64 of a user attachment (attachment:// reference) — no network fetch */
        base64?: string
        ext?: string
        keepSrcRect?: boolean
      },
    ) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const slide = session.opened.deck.slides[op.slideIndex]
      if (!slide) return null
      // The AI layer may address the picture by its durable id — translate to the
      // parse-time id the engine matches
      const targetId =
        slide.elements.find((el) => matchesElementRef(el, String(op.sourceId)))?.id ??
        String(op.sourceId)
      try {
        let buf: Buffer
        let ext: string
        if (op.base64 != null) {
          const decoded = attachmentImageBytes(op.base64, op.ext ?? '')
          if (!decoded) return null
          ;({ buf, ext } = decoded)
        } else {
          const imageUrl = String(op.url)
          const resp = responseForImageUrl(imageUrl) ?? (await fetchRemoteImage(imageUrl))
          if (!resp || !resp.ok) return null
          const bytes = await readImageResponseLimited(resp)
          if (!bytes) return null
          buf = bytes
          const ct = resp.headers.get('content-type') ?? ''
          ext = ct.includes('png')
            ? 'png'
            : ct.includes('gif')
              ? 'gif'
              : ct.includes('webp')
                ? 'webp'
                : 'jpg'
        }
        pushHistory(session)
        const ok = replacePictureBytes(
          session.opened,
          slide,
          targetId,
          new Uint8Array(buf),
          ext,
          op.keepSrcRect ? { keepSrcRect: true } : undefined,
        )
        if (!ok) {
          session.undoStack.pop()
          scheduleHistoryNotify(session)
          return null
        }
        // A replacement with a different aspect ratio would be stretched into
        // the surviving frame — center-crop it to cover the frame instead.
        if (!op.keepSrcRect) {
          const pic = slide.elements.find((el) => el.id === targetId && el.type === 'picture')
          const frame = pic?.transform?.offset
          if (frame) {
            const natural = nativeImage.createFromBuffer(buf).getSize()
            const crop = coverCropFractions(natural.width, natural.height, frame.cx, frame.cy)
            if (crop) editPictureSrcRect(slide, targetId, crop)
          }
        }
        return rebuildSlide(session, op.slideIndex)
      } catch {
        return null
      }
    },
  )

  // ── Style Skill sidecar persistence: write a same-named .styleskill.json next to the draft (fail-open)
  ipcMain.handle(
    'ai:save-sidecar',
    async (
      event,
      data: { topic: string; styleSkill: string; createdAt: string },
    ): Promise<{ ok: boolean }> => {
      try {
        const session = sessions.get(event.sender.id)
        const draftPath = session?.path
        if (!draftPath || !draftPath.endsWith('.pptx')) return { ok: false }
        const sidecarPath = draftPath.replace(/\.pptx$/i, '.styleskill.json')
        writeFileSync(sidecarPath, JSON.stringify(data, null, 2))
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
  )

  // ── Style template save: stored in userData/style-templates/<name>.json
  const STYLE_TEMPLATES_DIR = () => join(app.getPath('userData'), 'style-templates')

  ipcMain.handle(
    'ai:save-style-template',
    (
      _event,
      name: string,
      data: { topic: string; styleSkill: string; createdAt: string },
    ): { ok: boolean; error?: string } => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        mkdirSync(dir, { recursive: true })
        // Filename: replace illegal characters in the name with _ then truncate to 64 chars
        const safeName = name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)
        if (!safeName) return { ok: false, error: tm('errTplNameInvalid') }
        writeJson(join(dir, `${safeName}.json`), { ...data, name: safeName })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // ── Style template list
  ipcMain.handle(
    'ai:list-style-templates',
    (): Array<{ name: string; topic: string; createdAt: string }> => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        if (!existsSync(dir)) return []
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
        return files
          .map((f) => {
            try {
              const raw = readJson<{
                name?: string
                topic?: string
                createdAt?: string
                styleSkill?: string
              }>(join(dir, f), {})
              return {
                name: raw.name ?? f.replace(/\.json$/, ''),
                topic: raw.topic ?? '',
                createdAt: raw.createdAt ?? '',
              }
            } catch {
              return null
            }
          })
          .filter(Boolean) as Array<{ name: string; topic: string; createdAt: string }>
      } catch {
        return []
      }
    },
  )

  // ── Style template load
  ipcMain.handle(
    'ai:load-style-template',
    (
      _event,
      name: string,
    ): { ok: boolean; styleSkill?: string; topic?: string; error?: string } => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        const safeName = name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)
        const filePath = join(dir, `${safeName}.json`)
        if (!existsSync(filePath)) return { ok: false, error: tm('errTplMissing', { name }) }
        const raw = readJson<{ styleSkill?: string; topic?: string }>(filePath, {})
        if (!raw.styleSkill) return { ok: false, error: tm('errTplNoSkill', { name }) }
        return { ok: true, styleSkill: raw.styleSkill, topic: raw.topic ?? '' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
