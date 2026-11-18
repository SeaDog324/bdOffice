import {
  activeProvider,
  defaultAiSettings,
  maxOutputTokensOf,
  resolveAiSettings,
} from './providers'
import { chatForProvider } from './chat'
import { isAiNetworkError } from './network-error'
import { isAiOverloadedError } from './overload-error'
import { AiCreditsError, streamForProvider } from './stream'
import type {
  AiChatRequest,
  AiChatResponse,
  AiProviderId,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  LegacyAiSettings,
} from './types'
import { AiTimeoutError } from './watchdog'
import { registerAiModelDiscoveryIpc } from './model-discovery-ipc'

/** Minimal Electron shapes keep this package usable without an Electron dependency. */
export interface AiIpcSenderLike {
  id: number
  isDestroyed(): boolean
  send(channel: string, value: unknown): void
  once?(event: 'destroyed', listener: () => void): unknown
  removeListener?(event: 'destroyed', listener: () => void): unknown
}

export interface AiIpcEventLike {
  sender: AiIpcSenderLike
}

export type AiIpcHandler = (event: AiIpcEventLike, ...args: unknown[]) => unknown

export interface AiIpcMainLike {
  handle(channel: string, listener: AiIpcHandler): void
}

/** Optional desktop account route. A handled failure must never fall back to API billing. */
export interface AiAccountRoute {
  selection(): 'api' | 'codex' | 'claude'
  stream(event: AiIpcEventLike, request: AiStreamRequest): Promise<boolean>
  cancel(event: AiIpcEventLike, requestId: string): void
  chat(event: AiIpcEventLike, request: AiChatRequest): Promise<AiChatResponse | null>
}

export interface StandaloneAiIpcOptions {
  ipcMain: AiIpcMainLike
  readSettings(): Partial<AiSettings> & LegacyAiSettings
  writeSettings(settings: AiSettings): void
  webSearch?(query: string, maxResults: number): Promise<unknown>
  imageSearch?(query: string, maxResults: number): Promise<unknown>
  fetchImage?(url: string): Promise<unknown>
  noApiKeyMessage?(provider: AiProviderId): string
  noModelMessage?(): string
  onStreamError?(error: unknown, request: AiStreamRequest): void
  /** Test seam; production callers use the selected provider implementation. */
  stream?: typeof streamForProvider
  /** Test seam; production callers use the selected provider implementation. */
  chat?: typeof chatForProvider
}

interface RegisteredAiIpc {
  streams: Map<string, AbortController>
}

const registered = new WeakMap<object, RegisteredAiIpc>()

function streamKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`
}

function normalizedSettings(stored: Partial<AiSettings> & LegacyAiSettings): AiSettings {
  return resolveAiSettings(stored, defaultAiSettings())
}

function errorCode(error: unknown): Pick<AiStreamChunk, 'errorCode'> {
  if (error instanceof AiTimeoutError) return { errorCode: 'timeout' }
  if (error instanceof AiCreditsError) return { errorCode: 'credits' }
  if (isAiNetworkError(error)) return { errorCode: 'network' }
  if (isAiOverloadedError(error)) return { errorCode: 'overloaded' }
  return {}
}

/**
 * Register the shared ai:* surface for an editor running as its own Electron
 * process. The Electron ipcMain object is the registration key, so repeated
 * startup/window creation is harmless. Stream cancellation is scoped by sender
 * id as well as request id, preventing one window from cancelling another.
 */
export function registerStandaloneAiIpc(options: StandaloneAiIpcOptions): boolean {
  const key = options.ipcMain as object
  if (registered.has(key)) return false

  const state: RegisteredAiIpc = { streams: new Map() }
  registered.set(key, state)
  registerAiModelDiscoveryIpc(options.ipcMain)

  const handle = (channel: string, listener: AiIpcHandler): void => {
    options.ipcMain.handle(channel, listener)
  }

  handle('ai:get-settings', () => normalizedSettings(options.readSettings()))

  handle('ai:set-settings', (_event, value) => {
    const stored =
      value && typeof value === 'object'
        ? (value as Partial<AiSettings> & LegacyAiSettings)
        : ({} as Partial<AiSettings> & LegacyAiSettings)
    options.writeSettings(normalizedSettings(stored))
  })

  handle('ai:stream', async (event, value) => {
    const request = value as AiStreamRequest
    const requestId = typeof request?.requestId === 'string' ? request.requestId : ''
    if (!requestId) return

    const settings = normalizedSettings(request.settings)
    const provider = activeProvider(settings)
    const config = settings.providers[provider]
    const send = (chunk: AiStreamChunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream-chunk', chunk)
    }
    if (!config.apiKey) {
      send({
        requestId,
        type: 'error',
        error: options.noApiKeyMessage?.(provider) ?? '尚未配置所选模型服务商的 API 密钥',
      })
      return
    }
    if (!config.model) {
      send({
        requestId,
        type: 'error',
        error: options.noModelMessage?.() ?? '尚未配置聊天模型',
      })
      return
    }

    const key = streamKey(event.sender.id, requestId)
    state.streams.get(key)?.abort()
    const controller = new AbortController()
    state.streams.set(key, controller)
    const sendCurrent = (chunk: AiStreamChunk) => {
      if (state.streams.get(key) === controller) send(chunk)
    }
    const abortWhenDestroyed = () => controller.abort()
    event.sender.once?.('destroyed', abortWhenDestroyed)

    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < 5_000) return
      lastPing = now
      sendCurrent({ requestId, type: 'ping' })
    }

    try {
      let stopReason: string | undefined
      await (options.stream ?? streamForProvider)(
        provider,
        config,
        request.system,
        request.messages,
        request.tools ?? [],
        request.maxTokens ?? maxOutputTokensOf(settings),
        {
          signal: controller.signal,
          onDelta: (text) => sendCurrent({ requestId, type: 'delta', text }),
          onUsage: (usage) => sendCurrent({ requestId, type: 'usage', usage }),
          onReasoningDelta: (text) => sendCurrent({ requestId, type: 'reasoning', text }),
          onToolCall: (toolCall) => sendCurrent({ requestId, type: 'tool-call', toolCall }),
          onActivity: ping,
          onStopReason: (reason) => {
            stopReason = reason
          },
        },
      )
      sendCurrent({ requestId, type: 'done', ...(stopReason ? { stopReason } : {}) })
    } catch (error) {
      if (controller.signal.aborted) {
        sendCurrent({ requestId, type: 'done' })
      } else {
        options.onStreamError?.(error, request)
        sendCurrent({
          requestId,
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          ...errorCode(error),
        })
      }
    } finally {
      event.sender.removeListener?.('destroyed', abortWhenDestroyed)
      if (state.streams.get(key) === controller) state.streams.delete(key)
    }
  })

  handle('ai:stream-cancel', (event, value) => {
    if (typeof value !== 'string' || !value) return
    state.streams.get(streamKey(event.sender.id, value))?.abort()
  })

  handle('ai:web-search', async (_event, query, maxResults) => {
    try {
      if (!options.webSearch) throw new Error('web search is unavailable')
      return await options.webSearch(
        String(query ?? ''),
        typeof maxResults === 'number' ? maxResults : 6,
      )
    } catch (error) {
      return { results: [], method: 'error', error: String(error) }
    }
  })

  handle('ai:image-search', async (_event, query, maxResults) => {
    try {
      if (!options.imageSearch) throw new Error('image search is unavailable')
      return await options.imageSearch(
        String(query ?? ''),
        typeof maxResults === 'number' ? maxResults : 8,
      )
    } catch (error) {
      return { images: [], method: 'error', error: String(error) }
    }
  })

  if (options.fetchImage) {
    handle('ai:fetch-image', async (_event, value) => {
      try {
        return await options.fetchImage!(String(value ?? ''))
      } catch {
        return null
      }
    })
  }

  handle('ai:chat', async (_event, value) => {
    const request = value as AiChatRequest
    const settings = normalizedSettings(request.settings)
    const provider = activeProvider(settings)
    const config = settings.providers[provider]
    if (!config.apiKey) {
      return {
        ok: false,
        error: options.noApiKeyMessage?.(provider) ?? '尚未配置所选模型服务商的 API 密钥',
      }
    }
    if (!config.model) {
      return { ok: false, error: options.noModelMessage?.() ?? '尚未配置聊天模型' }
    }
    try {
      return await (options.chat ?? chatForProvider)(
        provider,
        config,
        String(request.system ?? ''),
        String(request.user ?? ''),
      )
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  return true
}
