import type { AiIpcMainLike } from './ipc'
import { listModelsForProvider } from './model-discovery'
import type { AiModelListRequest, AiModelListResponse } from './types'

const registered = new WeakSet<object>()

/** Each window owns at most one discovery request; cancellation never crosses windows. */
export function registerAiModelDiscoveryIpc(
  ipcMain: AiIpcMainLike,
  listModels = listModelsForProvider,
): void {
  if (registered.has(ipcMain)) return
  registered.add(ipcMain)
  const active = new Map<number, { requestId: string; controller: AbortController }>()
  ipcMain.handle('ai:list-models', async (event, value): Promise<AiModelListResponse> => {
    const request = value as AiModelListRequest
    if (typeof request?.requestId !== 'string' || !/^[\w-]{1,128}$/u.test(request.requestId)) {
      return { ok: false, errorCode: 'invalid_request' }
    }
    if (event.sender.isDestroyed()) return { ok: false, errorCode: 'cancelled' }
    active.get(event.sender.id)?.controller.abort()
    const current = { requestId: request.requestId, controller: new AbortController() }
    active.set(event.sender.id, current)
    const abort = () => current.controller.abort()
    event.sender.once?.('destroyed', abort)
    try {
      const result = await listModels(request, { signal: current.controller.signal })
      return current.controller.signal.aborted ? { ok: false, errorCode: 'cancelled' } : result
    } catch {
      return { ok: false, errorCode: current.controller.signal.aborted ? 'cancelled' : 'network' }
    } finally {
      event.sender.removeListener?.('destroyed', abort)
      if (active.get(event.sender.id) === current) active.delete(event.sender.id)
    }
  })
  ipcMain.handle('ai:list-models-cancel', (event, requestId) => {
    const current = active.get(event.sender.id)
    if (current && current.requestId === requestId) current.controller.abort()
  })
}
