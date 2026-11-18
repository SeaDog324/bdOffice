import { ipcMain, type WebContents } from 'electron'
import { ENVIRONMENT_CHANNELS } from '../../shared/environment-api'
import type { EnvironmentService } from './service'
import { assertTrustedSettingsSender } from '../trusted-settings-sender'
const KNOWN_ERRORS = new Set([
  'report_expired',
  'plan_expired',
  'plan_changed',
  'nothing_to_repair',
  'request_conflict',
  'invalid_task_id',
  'unknown_task',
  'task_was_purged',
  'task_history_unavailable',
  'connection_required',
])
export function registerEnvironmentIpc(options: {
  contents(): WebContents | undefined
  service(): EnvironmentService
  askBigDog(): Promise<{ sessionId: string }>
}): void {
  const handle = (channel: string, run: (input: unknown) => unknown) => {
    ipcMain.handle(channel, async (event, input: unknown) => {
      assertTrustedSettingsSender(event, options.contents())
      try {
        return await run(input)
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        // eslint-disable-next-line preserve-caught-error -- IPC exposes only public codes, never raw response bodies or credentials.
        throw new Error(KNOWN_ERRORS.has(code) ? code : 'environment_operation_failed')
      }
    })
  }
  handle(ENVIRONMENT_CHANNELS.check, () => options.service().check())
  handle(ENVIRONMENT_CHANNELS.plan, (id) => {
    if (typeof id !== 'string' || id.length > 128) throw new Error('report_expired')
    return options.service().plan(id)
  })
  handle(ENVIRONMENT_CHANNELS.repair, (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('plan_changed')
    const value = input as Record<string, unknown>
    if (
      !['requestId', 'planId', 'digest'].every(
        (key) => typeof value[key] === 'string' && (value[key] as string).length <= 128,
      )
    )
      throw new Error('plan_changed')
    return options.service().repair(value as { requestId: string; planId: string; digest: string })
  })
  handle(ENVIRONMENT_CHANNELS.task, (id) => {
    if (typeof id !== 'string') throw new Error('invalid_task_id')
    return options.service().task(id)
  })
  handle(ENVIRONMENT_CHANNELS.cancelTask, (id) => {
    if (typeof id !== 'string') throw new Error('invalid_task_id')
    return options.service().cancelTask(id)
  })
  handle(ENVIRONMENT_CHANNELS.recentRepairs, () => options.service().recentRepairs())
  handle(ENVIRONMENT_CHANNELS.askBigDog, () => options.askBigDog())
}
