import { createHash, randomUUID } from 'node:crypto'
import type {
  EnvironmentCheck,
  EnvironmentReport,
  EnvironmentRepairPlan,
  MaintenanceTask,
  RepairActionId,
} from '../../shared/environment-api'
import type { TaskStore } from '../agent-tasks/store'

export interface RepairResource {
  state: 'ready' | 'repairable' | 'blocked'
  version: string
}
export interface EnvironmentInspection {
  checks: EnvironmentCheck[]
  resources: Record<RepairActionId, RepairResource>
  aiAvailable: boolean
}
export interface EnvironmentAdapter {
  refresh?(): void
  inspect(): Promise<EnvironmentInspection>
  repair(action: RepairActionId): Promise<void>
}
interface StoredReport {
  report: EnvironmentReport
  inspection: EnvironmentInspection
}
interface StoredPlan {
  plan: EnvironmentRepairPlan
  resources: EnvironmentInspection['resources']
  beforeReport: EnvironmentReport
}
const PLAN_TTL_MS = 10 * 60_000
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ACTIONS: readonly RepairActionId[] = [
  'ensure_owned_directories',
  'repair_owned_cli_link',
  'rebuild_owned_derived_cache',
]
const errorCode = (error: unknown, fallback: string) => {
  const code = error instanceof Error ? error.message : ''
  return /^[a-z][a-z0-9_]{1,64}$/.test(code) ? code : fallback
}

/** Settings and Agent share the same catalog, preconditions, ledger and post-checks. */
export class EnvironmentService {
  private readonly reports = new Map<string, StoredReport>()
  private readonly plans = new Map<string, StoredPlan>()
  private readonly jobs = new Map<string, Promise<void>>()
  private checking: Promise<EnvironmentReport> | null = null
  private activeRepair: string | null = null
  constructor(
    private readonly options: {
      adapter: EnvironmentAdapter
      store(): TaskStore
      title(kind: 'diagnostic' | 'repair'): string
      now?: () => number
    },
  ) {}
  private now() {
    return (this.options.now ?? Date.now)()
  }
  private remember(
    inspection: EnvironmentInspection,
    extraChecks: EnvironmentCheck[] = [],
  ): EnvironmentReport {
    const checks = [...inspection.checks, ...extraChecks]
    const report: EnvironmentReport = {
      id: randomUUID(),
      checkedAt: this.now(),
      aiAvailable: inspection.aiAvailable,
      checks,
      overall: checks.some((check) => ['blocked', 'degraded'].includes(check.status))
        ? 'attention'
        : 'ready',
    }
    this.reports.set(report.id, {
      report: structuredClone(report),
      inspection: structuredClone(inspection),
    })
    while (this.reports.size > 20) this.reports.delete(this.reports.keys().next().value!)
    return report
  }
  check(source: 'settings' | 'agent' = 'settings'): Promise<EnvironmentReport> {
    if (this.checking) return this.checking
    const checking = this.runCheck(source).finally(() => {
      if (this.checking === checking) this.checking = null
    })
    this.checking = checking
    return checking
  }
  private async runCheck(source: 'settings' | 'agent'): Promise<EnvironmentReport> {
    this.options.adapter.refresh?.()
    let store: TaskStore | undefined, task: MaintenanceTask | undefined
    try {
      store = this.options.store()
      task = store.accept({
        requestId: randomUUID(),
        source,
        kind: 'diagnostic',
        title: this.options.title('diagnostic'),
        context: {},
        actions: [],
      }).task
      store.transition(task.id, 'running')
    } catch {
      store = undefined
    }
    try {
      const inspection = await this.options.adapter.inspect()
      const report = this.remember(inspection, [
        {
          id: 'task_history',
          status: store ? 'ok' : 'blocked',
          required: true,
          code: store ? 'task_history_ready' : 'task_history_unavailable',
        },
      ])
      if (store && task) store.transition(task.id, 'completed', { report })
      return report
    } catch (error) {
      if (store && task)
        store.transition(task.id, 'failed', { errorCode: 'environment_check_failed' })
      throw new Error(errorCode(error, 'environment_check_failed'), { cause: error })
    }
  }
  plan(reportId: string): EnvironmentRepairPlan {
    const record = this.reports.get(reportId)
    if (!record || this.now() - record.report.checkedAt > PLAN_TTL_MS)
      throw new Error('report_expired')
    const actions = ACTIONS.filter(
      (action) => record.inspection.resources[action].state === 'repairable',
    )
    const plan: EnvironmentRepairPlan = {
      id: randomUUID(),
      reportId,
      expiresAt: this.now() + PLAN_TTL_MS,
      actions,
      digest: digest(
        actions.map((action) => ({ action, version: record.inspection.resources[action].version })),
      ),
    }
    this.plans.set(plan.id, {
      plan: structuredClone(plan),
      resources: structuredClone(record.inspection.resources),
      beforeReport: structuredClone(record.report),
    })
    while (this.plans.size > 20) this.plans.delete(this.plans.keys().next().value!)
    return plan
  }
  inspectPlan(planId: string, expectedDigest?: string): EnvironmentRepairPlan {
    const saved = this.plans.get(planId)
    if (!saved || saved.plan.expiresAt < this.now()) throw new Error('plan_expired')
    if (expectedDigest !== undefined && saved.plan.digest !== expectedDigest)
      throw new Error('plan_changed')
    return structuredClone(saved.plan)
  }
  repair(
    input: { requestId: string; planId: string; digest: string },
    source: 'settings' | 'agent' = 'settings',
  ): MaintenanceTask {
    let store: TaskStore
    try {
      store = this.options.store()
    } catch (error) {
      throw new Error('task_history_unavailable', { cause: error })
    }
    const existing = store.findRepair(input, source)
    if (existing) return existing
    const saved = this.plans.get(input.planId)
    if (!saved || saved.plan.expiresAt < this.now()) throw new Error('plan_expired')
    if (input.digest !== saved.plan.digest) throw new Error('plan_changed')
    if (!saved.plan.actions.length) throw new Error('nothing_to_repair')
    const accepted = store.accept({
      requestId: input.requestId,
      source,
      kind: 'repair',
      title: this.options.title('repair'),
      context: { planId: input.planId, digest: input.digest, beforeReport: saved.beforeReport },
      actions: saved.plan.actions,
    })
    if (accepted.duplicate) return accepted.task
    if (this.activeRepair)
      return store.transition(accepted.task.id, 'failed', { errorCode: 'repair_in_progress' })
    this.activeRepair = accepted.task.id
    const pending = this.runRepair(accepted.task.id, saved).finally(() => {
      this.jobs.delete(accepted.task.id)
      if (this.activeRepair === accepted.task.id) this.activeRepair = null
    })
    this.jobs.set(accepted.task.id, pending)
    // IPC acknowledges the persisted task; UI closure never cancels its execution.
    void pending.catch(() => {})
    return store.get(accepted.task.id)
  }
  private async runRepair(id: string, saved: StoredPlan): Promise<void> {
    const store = this.options.store()
    const stopAtCheckpoint = async () => {
      if (store.get(id).pendingControl !== 'cancel') return false
      const inspection = await this.options.adapter.inspect()
      store.transition(id, 'cancelled', { report: this.remember(inspection) })
      return true
    }
    try {
      store.transition(id, 'running')
      for (const step of store.get(id).steps) {
        if (await stopAtCheckpoint()) return
        const before = await this.options.adapter.inspect()
        if (await stopAtCheckpoint()) return
        const resource = before.resources[step.action]
        if (
          resource.state === 'blocked' ||
          (resource.state !== 'ready' && resource.version !== saved.resources[step.action].version)
        )
          throw new Error('repair_precondition_changed')
        store.step(id, step.id, 'executing')
        if (resource.state === 'ready') {
          store.step(id, step.id, 'verified', 'already_ready', 'not_applied')
          continue
        }
        try {
          await this.options.adapter.repair(step.action)
          store.transition(id, 'verifying')
          const after = await this.options.adapter.inspect()
          if (after.resources[step.action].state !== 'ready')
            throw new Error('repair_verification_failed')
          store.step(id, step.id, 'verified', 'verified')
          store.transition(id, 'running')
        } catch (error) {
          store.step(id, step.id, 'failed', errorCode(error, 'repair_failed'))
          throw error
        }
      }
      store.transition(id, 'verifying')
      const inspection = await this.options.adapter.inspect()
      if (saved.plan.actions.some((action) => inspection.resources[action].state !== 'ready'))
        throw new Error('repair_verification_failed')
      const report = this.remember(inspection, [
        { id: 'task_history', status: 'ok', required: true, code: 'task_history_ready' },
      ])
      store.transition(id, 'completed', { report })
    } catch (error) {
      const task = store.get(id)
      if (['queued', 'running', 'verifying'].includes(task.state)) {
        let report: EnvironmentReport | undefined
        try {
          report = this.remember(await this.options.adapter.inspect())
        } catch {}
        store.transition(id, 'failed', { errorCode: errorCode(error, 'repair_failed'), report })
      }
    }
  }
  task(id: string): MaintenanceTask {
    return this.options.store().get(id)
  }
  recentRepairs(): MaintenanceTask[] {
    return this.options.store().recentRepairs()
  }
  cancelTask(id: string): MaintenanceTask {
    return this.jobs.has(id) ? this.options.store().requestCancel(id) : this.task(id)
  }
  async wait(id: string, signal?: AbortSignal): Promise<MaintenanceTask> {
    const pending = this.jobs.get(id)
    if (pending) {
      if (!signal) await pending
      else
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            signal.removeEventListener('abort', abort)
            try {
              this.cancelTask(id)
            } catch {}
            reject(new Error('wait_cancelled'))
          }
          if (signal.aborted) {
            abort()
            return
          }
          signal.addEventListener('abort', abort, { once: true })
          void pending.then(
            () => {
              signal.removeEventListener('abort', abort)
              resolve()
            },
            () => {
              signal.removeEventListener('abort', abort)
              resolve()
            },
          )
        })
    }
    return this.task(id)
  }
}
