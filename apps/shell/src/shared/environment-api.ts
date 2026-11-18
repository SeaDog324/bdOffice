export type EnvironmentStatus = 'ok' | 'degraded' | 'blocked' | 'unconfigured' | 'not_applicable'
export type RepairActionId =
  'ensure_owned_directories' | 'repair_owned_cli_link' | 'rebuild_owned_derived_cache'
export type EnvironmentCheckId =
  | 'storage'
  | 'bundled_cli'
  | 'cli_discovery'
  | 'terminal_entry'
  | 'native_engine'
  | 'render_resources'
  | 'ai_connection'
  | 'search_index'
  | 'task_history'
  | 'computer_use'
export interface EnvironmentCheck {
  id: EnvironmentCheckId
  status: EnvironmentStatus
  required: boolean
  code: string
  repairAction?: RepairActionId
}
export interface EnvironmentReport {
  id: string
  checkedAt: number
  overall: 'ready' | 'attention'
  aiAvailable: boolean
  checks: EnvironmentCheck[]
}
export interface EnvironmentRepairPlan {
  id: string
  reportId: string
  digest: string
  expiresAt: number
  actions: RepairActionId[]
}
export type MaintenanceTaskState =
  'queued' | 'running' | 'verifying' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
export interface MaintenanceStep {
  id: string
  action: RepairActionId
  state: 'planned' | 'executing' | 'verified' | 'failed' | 'awaiting_reconciliation' | 'cancelled'
  resultCode?: string
  effectState?: 'applied' | 'not_applied' | 'unknown'
}
export interface MaintenanceTask {
  id: string
  kind: 'diagnostic' | 'repair'
  title: string
  state: MaintenanceTaskState
  revision: number
  createdAt: number
  updatedAt: number
  steps: MaintenanceStep[]
  report?: EnvironmentReport
  beforeReport?: EnvironmentReport
  errorCode?: string
  pendingControl?: 'cancel'
}
export interface EnvironmentApi {
  check(): Promise<EnvironmentReport>
  plan(reportId: string): Promise<EnvironmentRepairPlan>
  repair(input: { requestId: string; planId: string; digest: string }): Promise<MaintenanceTask>
  task(id: string): Promise<MaintenanceTask>
  cancelTask(id: string): Promise<MaintenanceTask>
  recentRepairs(): Promise<MaintenanceTask[]>
  askBigDog(): Promise<{ sessionId: string }>
}
export const ENVIRONMENT_CHANNELS = {
  check: 'environment:check',
  plan: 'environment:plan',
  repair: 'environment:repair',
  task: 'environment:task',
  recentRepairs: 'environment:recent-repairs',
  askBigDog: 'environment:ask-bigdog',
  cancelTask: 'environment:cancel-task',
} as const
declare global {
  interface Window {
    aiOfficeEnvironment: EnvironmentApi
  }
}
