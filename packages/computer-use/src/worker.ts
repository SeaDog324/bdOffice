import type { CuaDriverLike } from '@trycua/cua-driver'
import { pathToFileURL } from 'node:url'
import {
  CUA_SDK_VERSION,
  DRIVER_TOOLS,
  MAX_IMAGE_BYTES,
  MAX_TOOL_TEXT,
  driverJson,
  isRecord,
  type DriverResult,
  type WorkerRequest,
} from './protocol'

/** The only process that loads native code. No model keys or account clients are used. */
export function runComputerWorker(): void {
  let driver: CuaDriverLike | undefined
  let starting: Promise<CuaDriverLike> | undefined
  let active: { id: string; controller: AbortController } | undefined
  const sessions = new Set<string>()
  const getDriver = () =>
    (starting ??= (
      process.env.BIGDOG_CUA_SDK_ENTRY
        ? (import(
            /* @vite-ignore */ pathToFileURL(process.env.BIGDOG_CUA_SDK_ENTRY).href
          ) as Promise<typeof import('@trycua/cua-driver')>)
        : import('@trycua/cua-driver')
    )
      .then(async (sdk) => {
        const instance = sdk.CuaDriver.create({ embedded: true, claudeCodeCompatibility: false })
        const metadata = await instance.metadata()
        if (metadata.driverVersion !== CUA_SDK_VERSION) {
          await instance.shutdown()
          throw new Error('computer_sdk_version_mismatch')
        }
        driver = instance
        return instance
      })
      .catch((error) => {
        starting = undefined
        throw error
      }))
  const send = (value: unknown) => {
    if (process.connected) process.send?.(value)
  }
  process.on('message', async (raw: unknown) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length > 64) return
    const request = raw as unknown as WorkerRequest
    if (request.method === 'cancel') {
      if (active?.id === request.requestId) active.controller.abort()
      send({ id: request.id, result: true })
      return
    }
    if (active) {
      send({ id: request.id, error: 'computer_driver_busy' })
      return
    }
    const controller = new AbortController()
    active = { id: request.id, controller }
    try {
      const sdk = await getDriver()
      if (controller.signal.aborted) throw new Error('computer_cancelled')
      if (request.method === 'status') {
        send({
          id: request.id,
          result: {
            available: sdk.isAvailable(),
            version: CUA_SDK_VERSION,
            platform: process.platform,
            state: 'ready',
          },
        })
      } else if (request.method === 'end') {
        if (sessions.delete(request.session))
          await sdk.callTool('end_session', JSON.stringify({ session: request.session }), {
            signal: controller.signal,
          })
        send({ id: request.id, result: true })
      } else if (request.method === 'call') {
        if (
          !DRIVER_TOOLS.has(request.tool) ||
          !isRecord(request.args) ||
          !/^[a-z0-9-]{1,80}$/.test(request.session)
        )
          throw new Error('computer_invalid_request')
        if (JSON.stringify(request.args).length > 32_000)
          throw new Error('computer_request_too_large')
        if (!sessions.has(request.session)) {
          await sdk.callTool('start_session', JSON.stringify({ session: request.session }), {
            signal: controller.signal,
          })
          sessions.add(request.session)
        }
        const args: Record<string, unknown> = { ...request.args, session: request.session }
        if (typeof args.window_id === 'string' && /^\d{1,20}$/.test(args.window_id))
          args.window_id = BigInt(args.window_id) as never
        const result = await sdk.callTool(request.tool, driverJson(args), {
          signal: controller.signal,
        })
        let data: unknown = {}
        try {
          data = JSON.parse(result.structuredJson || '{}')
        } catch {}
        const bounded: DriverResult = {
          text: result.text.slice(0, MAX_TOOL_TEXT),
          data: sanitize(data) as Record<string, unknown>,
          images: result.images
            .slice(0, 1)
            .filter(
              (image) =>
                image.dataBase64.length <= Math.ceil((MAX_IMAGE_BYTES * 4) / 3) &&
                /^image\/(png|jpeg)$/.test(image.mimeType),
            )
            .map((image) => ({ mime: image.mimeType, base64: image.dataBase64 })),
          isError: result.isError,
          ...(result.action
            ? {
                effect: (
                  ['confirmed', 'partial', 'unverifiable', 'suspected_noop', 'refused'] as const
                )[result.action.effect],
              }
            : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        }
        send({ id: request.id, result: bounded })
      } else throw new Error('computer_invalid_request')
    } catch (error) {
      // Do not log native error objects: they may embed captured UI text.
      send({
        id: request.id,
        error: controller.signal.aborted ? 'computer_cancelled' : safeError(error),
      })
    } finally {
      active = undefined
    }
  })
  process.once('disconnect', () => {
    active?.controller.abort()
    const timer = setTimeout(() => process.exit(0), 2000)
    void driver?.shutdown().finally(() => {
      clearTimeout(timer)
      process.exit(0)
    })
    if (!driver) process.exit(0)
  })
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^computer_[a-z_]+$/.test(message) ? message : 'computer_driver_failed'
}
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[nested content omitted]'
  if (typeof value === 'string')
    return value.length > MAX_TOOL_TEXT ? value.slice(0, MAX_TOOL_TEXT) + '…' : value
  if (Array.isArray(value)) return value.slice(0, 300).map((item) => sanitize(item, depth + 1))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) => !/base64|^images?$|screenshot_data|screenshot_file_path|^next_call$/i.test(key),
      )
      .slice(0, 100)
      .map(([key, item]) => [key, sanitize(item, depth + 1)]),
  )
}
