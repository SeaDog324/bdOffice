import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  EnvironmentReport,
  MaintenanceTask,
  MaintenanceTaskState,
  RepairActionId,
} from '../../shared/environment-api'
import { TASK_SCHEMA } from './schema'
import { AssistantTaskStore } from './assistant-store'

type Row = Record<string, unknown>
const encode = (value: unknown) => {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > 256 * 1024) throw new Error('task_payload_too_large')
  return json
}
const hash = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex')
const identifier = (id: string) => {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) throw new Error('invalid_task_id')
  return id
}

/** Main-process maintenance ledger. It records interruptions and never replays old actions. */
export class TaskStore {
  private readonly db: DatabaseSync
  readonly assistant: AssistantTaskStore
  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true })
      if (
        lstatSync(dirname(path)).isSymbolicLink() ||
        (existsSync(path) && lstatSync(path).isSymbolicLink())
      )
        throw new Error('invalid_task_store')
    }
    this.db = new DatabaseSync(path)
    this.assistant = new AssistantTaskStore(this.db, now)
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
      if (version === 0) {
        if (
          Number(
            this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()!
              .n,
          )
        )
          throw new Error('unknown_task_store')
        this.db.exec(TASK_SCHEMA)
      } else if (version !== 1) throw new Error('unsupported_task_store')
      if (Number(this.db.prepare('PRAGMA application_id').get()!.application_id) !== 0x42444f47)
        throw new Error('unknown_task_store')
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok')
        throw new Error('task_store_corrupt')
      this.recover()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = run()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(identifier(id)) as
      Row | undefined
    if (!row) throw new Error('unknown_task')
    return row
  }
  private event(id: string, type: string, summary: string): void {
    const row = this.row(id)
    this.db
      .prepare(
        'INSERT INTO task_events(id,task_id,sequence,revision,type,summary,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        id,
        Number(row.next_event_sequence),
        Number(row.revision),
        type,
        summary,
        this.now(),
      )
    this.db
      .prepare('UPDATE tasks SET next_event_sequence = next_event_sequence + 1 WHERE id = ?')
      .run(id)
  }

  accept(input: {
    requestId: string
    source: 'settings' | 'agent'
    kind: 'diagnostic' | 'repair'
    title: string
    context: unknown
    actions: RepairActionId[]
  }): { task: MaintenanceTask; duplicate: boolean } {
    identifier(input.requestId)
    if (input.actions.length > 3) throw new Error('too_many_repair_actions')
    const digest = hash({
      requestId: input.requestId,
      source: input.source,
      kind: input.kind,
      context: input.context,
      actions: input.actions,
    })
    return this.transaction(() => {
      if (
        this.db
          .prepare(
            'SELECT 1 FROM task_tombstones WHERE authority_id = ? AND principal_id = ? AND request_id = ?',
          )
          .get('local', input.source, input.requestId)
      )
        throw new Error('task_was_purged')
      const existing = this.db
        .prepare(
          'SELECT id,request_hash FROM tasks WHERE authority_id=? AND principal_id=? AND request_id=?',
        )
        .get('local', input.source, input.requestId)
      if (existing) {
        if (existing.request_hash !== digest) throw new Error('request_conflict')
        return { task: this.get(String(existing.id)), duplicate: true }
      }
      const id = randomUUID(),
        stamp = this.now()
      this.db
        .prepare(
          'INSERT INTO tasks(id,authority_id,principal_id,request_id,request_hash,kind,title,goal_json,context_json,plan_json,budget_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          'local',
          input.source,
          input.requestId,
          digest,
          input.kind,
          input.title,
          encode({ kind: input.kind }),
          '{}',
          encode(input.context),
          encode({ maxActions: input.actions.length, usedActions: 0 }),
          'queued',
          stamp,
          stamp,
        )
      input.actions.forEach((action, index) => {
        this.db
          .prepare(
            'INSERT INTO task_steps(id,task_id,label,plan_revision,display_order,operation_digest,arguments_ref_json,targets_json,recovery,state,effect_state) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            id,
            action,
            1,
            index,
            hash({ digest, action }),
            encode({ action }),
            '[]',
            'verify_effect',
            'planned',
            'not_started',
          )
      })
      this.event(id, 'task.accepted', 'Task accepted')
      return { task: this.get(id), duplicate: false }
    })
  }
  findRepair(
    input: { requestId: string; planId: string; digest: string },
    source: 'settings' | 'agent',
  ): MaintenanceTask | null {
    const row = this.db
      .prepare(
        'SELECT id,kind,plan_json FROM tasks WHERE authority_id=? AND principal_id=? AND request_id=?',
      )
      .get('local', source, identifier(input.requestId))
    if (!row) return null
    const plan = JSON.parse(String(row.plan_json)) as { planId?: string; digest?: string }
    if (row.kind !== 'repair' || plan.planId !== input.planId || plan.digest !== input.digest)
      throw new Error('request_conflict')
    return this.get(String(row.id))
  }

  transition(
    id: string,
    state: MaintenanceTaskState,
    options: { report?: EnvironmentReport; errorCode?: string } = {},
  ): MaintenanceTask {
    return this.transaction(() => {
      const row = this.row(id),
        from = String(row.state)
      const allowed: Record<string, string[]> = {
        queued: ['running', 'failed', 'interrupted', 'cancelled'],
        running: ['verifying', 'completed', 'failed', 'interrupted', 'cancelled'],
        verifying: ['running', 'completed', 'failed', 'interrupted', 'cancelled'],
      }
      if (!allowed[from]?.includes(state)) throw new Error('invalid_task_transition')
      if (
        state === 'completed' &&
        Number(
          this.db
            .prepare("SELECT count(*) AS n FROM task_steps WHERE task_id=? AND state!='verified'")
            .get(id)!.n,
        )
      )
        throw new Error('task_not_verified')
      if (state === 'cancelled')
        this.db
          .prepare(
            "UPDATE task_steps SET state='cancelled',revision=revision+1 WHERE task_id=? AND state='planned'",
          )
          .run(id)
      this.db
        .prepare(
          'UPDATE tasks SET state=?,context_json=?,reason_code=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
        )
        .run(
          state,
          encode(
            options.report ? { report: options.report } : JSON.parse(String(row.context_json)),
          ),
          options.errorCode ?? null,
          this.now(),
          id,
          Number(row.revision),
        )
      this.event(id, 'task.' + state, state)
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(state))
        this.db.prepare('UPDATE tasks SET pending_control=NULL WHERE id=?').run(id)
      return this.get(id)
    })
  }

  step(
    id: string,
    stepId: string,
    state: 'executing' | 'verified' | 'failed',
    resultCode?: string,
    effectState: 'applied' | 'not_applied' | 'unknown' = state === 'verified'
      ? 'applied'
      : 'unknown',
  ): MaintenanceTask {
    return this.transaction(() => {
      const row = this.row(id)
      if (!['running', 'verifying'].includes(String(row.state))) throw new Error('task_not_running')
      const previous = this.db
        .prepare('SELECT state FROM task_steps WHERE id=? AND task_id=?')
        .get(stepId, id)
      if (
        !previous ||
        (state === 'executing' ? previous.state !== 'planned' : previous.state !== 'executing')
      )
        throw new Error('invalid_step_transition')
      this.db
        .prepare(
          'UPDATE task_steps SET state=?,effect_state=?,receipt_json=?,revision=revision+1 WHERE id=? AND task_id=?',
        )
        .run(
          state,
          state === 'executing' ? 'started' : effectState,
          encode({ resultCode, effectState: state === 'executing' ? undefined : effectState }),
          stepId,
          id,
        )
      this.db
        .prepare('UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?')
        .run(this.now(), id)
      if (state === 'executing')
        this.db
          .prepare(
            "UPDATE tasks SET budget_json=json_set(budget_json,'$.usedActions',coalesce(json_extract(budget_json,'$.usedActions'),0)+1) WHERE id=?",
          )
          .run(id)
      this.event(id, 'step.' + state, resultCode ?? state)
      return this.get(id)
    })
  }
  get(id: string): MaintenanceTask {
    const row = this.row(id)
    const context = JSON.parse(String(row.context_json)) as { report?: EnvironmentReport }
    const plan = JSON.parse(String(row.plan_json)) as { beforeReport?: EnvironmentReport }
    const steps = this.db
      .prepare(
        'SELECT id,label,state,receipt_json FROM task_steps WHERE task_id=? ORDER BY display_order',
      )
      .all(id)
    return {
      id: String(row.id),
      kind: row.kind as MaintenanceTask['kind'],
      title: String(row.title),
      state: row.state as MaintenanceTaskState,
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      steps: steps.map((step) => ({
        id: String(step.id),
        action: step.label as RepairActionId,
        state: step.state as MaintenanceTask['steps'][number]['state'],
        ...(step.receipt_json ? JSON.parse(String(step.receipt_json)) : {}),
      })),
      ...(context.report ? { report: context.report } : {}),
      ...(plan.beforeReport ? { beforeReport: plan.beforeReport } : {}),
      ...(row.reason_code ? { errorCode: String(row.reason_code) } : {}),
      ...(row.pending_control === 'cancel' ? { pendingControl: 'cancel' as const } : {}),
    }
  }
  recentRepairs(limit = 5): MaintenanceTask[] {
    return this.db
      .prepare(
        "SELECT id FROM tasks WHERE kind='repair' ORDER BY created_at DESC,rowid DESC LIMIT ?",
      )
      .all(Math.min(20, Math.max(1, limit)))
      .map((row) => this.get(String(row.id)))
  }
  requestCancel(id: string): MaintenanceTask {
    return this.transaction(() => {
      const row = this.row(id)
      if (
        row.kind !== 'repair' ||
        !['queued', 'running', 'verifying'].includes(String(row.state)) ||
        row.pending_control === 'cancel'
      )
        return this.get(id)
      this.db
        .prepare(
          "UPDATE tasks SET pending_control='cancel',revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(this.now(), id)
      this.event(
        id,
        'task.cancel_requested',
        'Stop after the current action reaches a safe checkpoint.',
      )
      return this.get(id)
    })
  }
  private recover(): void {
    this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id FROM tasks WHERE kind IN ('diagnostic','repair') AND state IN ('queued','preparing','running','verifying','pausing','cancelling')",
        )
        .all()
      for (const row of rows) {
        const id = String(row.id)
        this.db
          .prepare(
            "UPDATE tasks SET state='interrupted',reason_code='outcome_unknown',revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(this.now(), id)
        this.db
          .prepare(
            "UPDATE task_steps SET state='awaiting_reconciliation',effect_state='unknown',revision=revision+1 WHERE task_id=? AND state='executing'",
          )
          .run(id)
        this.event(
          id,
          'task.interrupted',
          'Previous operation interrupted; check current state before a new repair.',
        )
      }
    })
  }
  close(): void {
    this.db.close()
  }
}
