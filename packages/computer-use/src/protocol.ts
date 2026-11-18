import type { AgentImage } from '@genoffice/agent-core'

export const CUA_SDK_VERSION = '0.52.7'
export const MAX_TOOL_TEXT = 18_000
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const DRIVER_TOOLS = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
  'click',
  'type_text',
  'set_value',
  'press_key',
  'scroll',
  'drag',
  'bring_to_front',
  'launch_app',
  'verify_state',
])
export interface DriverResult {
  text: string
  data: Record<string, unknown>
  images: AgentImage[]
  isError: boolean
  errorCode?: string
  effect?: 'confirmed' | 'partial' | 'unverifiable' | 'suspected_noop' | 'refused'
}
export interface DriverStatus {
  available: boolean
  version: string
  platform: string
  state: 'stopped' | 'ready' | 'busy' | 'error'
  error?: string
}
export interface DriverPort {
  status(): Promise<DriverStatus>
  call(
    tool: string,
    args: Record<string, unknown>,
    session: string,
    signal?: AbortSignal,
  ): Promise<DriverResult>
  endSession(session: string): Promise<void>
  stop(): Promise<void>
}
export type WorkerRequest =
  | { id: string; method: 'status' }
  | { id: string; method: 'call'; tool: string; args: Record<string, unknown>; session: string }
  | { id: string; method: 'end'; session: string }
  | { id: string; method: 'cancel'; requestId: string }
export interface WorkerResponse {
  id: string
  result?: unknown
  error?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** Preserve 64-bit native handles at the Rust JSON boundary. */
export function driverJson(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return '[' + value.map(driverJson).join(',') + ']'
  if (isRecord(value))
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => JSON.stringify(k) + ':' + driverJson(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
