import { useCallback, useEffect, useRef, useState } from 'react'
import { ComputerUsePanel } from './ComputerUsePanel'
import type {
  EnvironmentReport,
  EnvironmentRepairPlan,
  MaintenanceTask,
} from '../../../shared/environment-api'
import { environmentCopy } from '../../../shared/environment-copy'
import { useI18n } from '../locale'
import { DogIllustration } from '../DogIllustration'
import './environment.css'

const active = (task: MaintenanceTask | null) =>
  !!task && ['queued', 'running', 'verifying'].includes(task.state)
export function EnvironmentPanel({
  onModels,
  onIntegrations,
  onUpdates,
  onClose,
}: {
  onModels(): void
  onIntegrations(): void
  onUpdates(): void
  onClose(): void
}) {
  const { lang } = useI18n(),
    copy = environmentCopy(lang),
    api = window.aiOfficeEnvironment
  const [report, setReport] = useState<EnvironmentReport | null>(null)
  const [plan, setPlan] = useState<EnvironmentRepairPlan | null>(null)
  const [task, setTask] = useState<MaintenanceTask | null>(null)
  const [history, setHistory] = useState<MaintenanceTask[]>([])
  const [phase, setPhase] = useState<'idle' | 'checking' | 'planning' | 'delegating'>('checking')
  const [error, setError] = useState('')
  const alive = useRef(true),
    generation = useRef(0)
  const describeError = (error: unknown) => {
    const raw = error instanceof Error ? error.message : ''
    const code = raw.match(/([a-z_]+)$/)?.[1] ?? ''
    return copy.errors[code] ?? copy.error
  }
  const check = useCallback(async () => {
    const epoch = ++generation.current
    setPhase('checking')
    setError('')
    try {
      const next = await api.check()
      if (!alive.current || epoch !== generation.current) return
      setReport(next)
      const [repairs, prepared] = await Promise.all([
        api.recentRepairs().catch(() => []),
        api.plan(next.id),
      ])
      if (!alive.current || epoch !== generation.current) return
      setHistory(repairs)
      setPlan(prepared)
      setTask(repairs.find((item) => active(item)) ?? repairs[0] ?? null)
    } catch (error) {
      if (alive.current && epoch === generation.current)
        setError(error instanceof Error ? error.message : 'environment_operation_failed')
    } finally {
      if (alive.current && epoch === generation.current) setPhase('idle')
    }
  }, [api])
  useEffect(() => {
    alive.current = true
    void check()
    return () => {
      alive.current = false
    }
  }, [check])
  const running = active(task)
  const taskId = task?.id
  useEffect(() => {
    if (!running || !taskId) return
    let current = true
    let pending = false
    const tick = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.task(taskId)
        if (!current || !alive.current) return
        setTask(next)
        if (!active(next)) {
          if (next.report) setReport(next.report)
          const repairs = await api.recentRepairs()
          if (current && alive.current) setHistory(repairs)
        }
      } catch {
        if (current && alive.current) setError('environment_operation_failed')
      } finally {
        pending = false
      }
    }
    const timer = setInterval(() => void tick(), 400)
    void tick()
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [api, taskId, running])

  const repair = async () => {
    if (phase !== 'idle' || running || !plan) return
    const epoch = ++generation.current
    setPhase('planning')
    setError('')
    try {
      // Dispatch the already-reviewed plan immediately; main revalidates every action.
      if (!plan.actions.length) return
      const next = await api.repair({
        requestId: crypto.randomUUID(),
        planId: plan.id,
        digest: plan.digest,
      })
      if (alive.current && epoch === generation.current) {
        setTask(next)
        if (next.report) setReport(next.report)
      }
    } catch (error) {
      if (alive.current && epoch === generation.current)
        setError(error instanceof Error ? error.message : 'environment_operation_failed')
    } finally {
      if (alive.current && epoch === generation.current) setPhase('idle')
    }
  }
  const ask = async () => {
    if (phase !== 'idle' || running) return
    setPhase('delegating')
    setError('')
    try {
      await api.askBigDog()
      onClose()
    } catch (error) {
      if (alive.current) {
        setError(error instanceof Error ? error.message : 'environment_operation_failed')
        setPhase('idle')
      }
    }
  }
  const busy = phase !== 'idle' || running
  const repairCount = report?.checks.filter((item) => item.repairAction).length ?? 0
  const hasCandidates = repairCount > 0
  const canRepair =
    hasCandidates && report?.checks.find((item) => item.id === 'task_history')?.status === 'ok'
  const expiresAt = plan?.expiresAt ?? 0
  useEffect(() => {
    if (!canRepair || busy || !expiresAt) return
    const timer = setTimeout(() => void check(), Math.max(0, expiresAt - Date.now() - 1000))
    return () => clearTimeout(timer)
  }, [busy, canRepair, check, expiresAt])
  const primary =
    report?.checks.filter(
      (item) => item.required || ['blocked', 'degraded'].includes(item.status),
    ) ?? []
  const optional = report?.checks.filter((item) => !primary.includes(item)) ?? []
  const repairLabel =
    hasCandidates && !primary.some((item) => item.repairAction) ? copy.optionalFix : copy.fix
  const checks = (items: EnvironmentReport['checks']) =>
    items.map((item) => (
      <div className="env-check" key={item.id} data-check={item.id} data-status={item.status}>
        <div>
          <strong>{copy.labels[item.id]}</strong>
          <p>{copy.messages[item.code] ?? copy.error}</p>
        </div>
        <span className={'env-status ' + item.status}>{copy.statuses[item.status]}</span>
      </div>
    ))
  return (
    <section className="environment-panel" aria-label={copy.section}>
      <div className="env-introduction">
        <div>
          <h3 className="set-pane-title">{copy.section}</h3>
          <p className="set-field-desc">{copy.description}</p>
        </div>
        <DogIllustration scene="inspect" className="env-illustration" />
      </div>
      <div className="env-summary" role="status">
        {phase === 'checking'
          ? copy.checking
          : report
            ? report.overall === 'ready'
              ? copy.ready
              : copy.attention
            : copy.error}
        {report && (
          <small>
            {copy.checked}: {new Date(report.checkedAt).toLocaleString(lang)}
          </small>
        )}
      </div>
      <div className="env-actions">
        <button
          className="set-btn"
          disabled={busy}
          aria-busy={phase === 'checking'}
          onClick={() => void check()}
        >
          {phase === 'checking' ? copy.checking : copy.check}
        </button>
        <button
          className="set-btn primary"
          disabled={busy || !canRepair || !plan}
          aria-busy={running || phase === 'planning'}
          onClick={() => void repair()}
        >
          {running || phase === 'planning'
            ? copy.fixing
            : `${repairLabel}${repairCount ? ` (${repairCount})` : ''}`}
        </button>
        <button
          className="set-btn"
          disabled={busy || !report?.aiAvailable}
          aria-busy={phase === 'delegating'}
          onClick={() => void ask()}
        >
          {phase === 'delegating' ? copy.asking : copy.ask}
        </button>
      </div>
      <p className="env-scope">{copy.scope}</p>
      {report && !hasCandidates && <p>{copy.noRepairs}</p>}
      {report && !report.aiAvailable && (
        <p className="env-connect">
          {copy.noAi}{' '}
          <button className="set-btn" onClick={onModels}>
            {copy.connect}
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="env-error">
          {describeError(new Error(error))}
        </p>
      )}
      {task && (
        <div className="env-task" data-task-state={task.state} aria-label={copy.taskProgress}>
          <strong>
            {copy.taskProgress}: {copy.taskStates[task.state]}
          </strong>
          {task.pendingControl === 'cancel' && <p role="status">{copy.stopping}</p>}
          {running && (
            <button
              className="set-btn"
              disabled={task.pendingControl === 'cancel'}
              onClick={() =>
                void api
                  .cancelTask(task.id)
                  .then(setTask)
                  .catch(() => setError('environment_operation_failed'))
              }
            >
              {copy.stop}
            </button>
          )}
          {task.state === 'interrupted' && <p>{copy.interruption}</p>}
          <ol>
            {task.steps.map((step) => (
              <li key={step.id} data-step-state={step.state}>
                <span>{copy.actions[step.action]}</span>
                <span>
                  {step.state === 'verified'
                    ? step.resultCode === 'already_ready'
                      ? copy.already
                      : copy.verified
                    : step.state === 'executing'
                      ? copy.fixing
                      : step.state === 'failed'
                        ? copy.taskStates.failed
                        : step.state === 'awaiting_reconciliation'
                          ? copy.taskStates.interrupted
                          : step.state === 'cancelled'
                            ? copy.taskStates.cancelled
                            : copy.taskStates.queued}
                </span>
              </li>
            ))}
          </ol>
          {task.errorCode && <p role="alert">{copy.errors[task.errorCode] ?? copy.error}</p>}
          {task.steps.some(
            (step) => step.action === 'rebuild_owned_derived_cache' && step.state === 'verified',
          ) && <p>{copy.backgroundIndex}</p>}
        </div>
      )}
      {checks(primary)}
      <details className="env-details">
        <summary>{copy.optional}</summary>
        {checks(optional)}
      </details>
      <div className="env-links">
        <button className="set-btn" onClick={onModels}>
          {copy.models}
        </button>
        <button className="set-btn" onClick={onIntegrations}>
          {copy.integrations}
        </button>
        <button className="set-btn" onClick={onUpdates}>
          {copy.updates}
        </button>
      </div>
      {window.aiOfficeComputer && <ComputerUsePanel />}
      {!!history.length && (
        <details className="env-details">
          <summary>{copy.advanced}</summary>
          {history.map((item) => (
            <div className="env-history" key={item.id}>
              <span>{new Date(item.createdAt).toLocaleString(lang)}</span>
              <span>{copy.taskStates[item.state]}</span>
            </div>
          ))}
        </details>
      )}
    </section>
  )
}
