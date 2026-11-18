import { taskLabels } from './state.mjs'

const terminal = new Set(['completed', 'failed', 'cancelled'])
const time = (value) => (typeof value === 'number' ? value : Date.parse(value || '') || 0)
export const taskTitle = (task) => String(task?.title || '未命名请求').slice(0, 160)
/** The task aggregate includes previous attempts; per-run evidence remains on the host. */
export function taskResultSummaries(records = []) {
  const byTask = new Map()
  for (const [index, record] of records.entries()) {
    const key = record.taskId ? `task:${record.taskId}` : `record:${record.id || index}`
    const previous = byTask.get(key)
    if (
      !previous ||
      (record.taskId && record.id === record.taskId) ||
      (previous.id !== previous.taskId && time(record.occurredAt) > time(previous.occurredAt))
    )
      byTask.set(key, record)
  }
  return [...byTask.values()].sort((a, b) => time(b.occurredAt) - time(a.occurredAt))
}
export function retryBudgetExhausted(task) {
  const budget = task?.budget
  if (!budget) return false
  return [
    ['usedAttempts', 'maxAttempts'],
    ['usedActiveMs', 'maxActiveMs'],
    ['usedModelTurns', 'maxModelTurns'],
  ].some(
    ([used, max]) =>
      Number.isFinite(budget[used]) && Number.isFinite(budget[max]) && budget[used] >= budget[max],
  )
}
export function selectTask(tasks, selectedId = '') {
  const selected = tasks.find((task) => task.id === selectedId)
  if (selected) return selected
  const oldest = (items) => [...items].sort((a, b) => time(a.createdAt) - time(b.createdAt))[0]
  return (
    oldest(tasks.filter((task) => task.state === 'waiting_user')) ||
    oldest(tasks.filter((task) => !terminal.has(task.state) && task.state !== 'queued')) ||
    oldest(tasks.filter((task) => !terminal.has(task.state))) ||
    [...tasks].sort(
      (a, b) => time(b.updatedAt) - time(a.updatedAt) || time(b.createdAt) - time(a.createdAt),
    )[0]
  )
}
export function taskOutcome(task, records = []) {
  if (task?.state !== 'completed') return ''
  return (
    [...records]
      .filter((record) => record.taskId === task.id)
      .sort((a, b) => time(b.occurredAt) - time(a.occurredAt))[0]?.outcome || ''
  )
}
export function taskStateLabel(task, records = []) {
  const outcome = taskOutcome(task, records)
  return outcome === 'partial'
    ? '部分完成'
    : outcome === 'failed'
      ? '操作未完成'
      : task
        ? taskLabels[task.state] || '状态待同步'
        : '就绪'
}
export function pendingPredecessor(task, tasks) {
  if (task?.state !== 'queued') return undefined
  return selectTask(
    tasks.filter(
      (item) => item.id !== task.id && item.state !== 'queued' && !terminal.has(item.state),
    ),
  )
}
const tools = {
  'docx.create': '创建 Word 文档',
  'docx.edit': '修改 Word 正文',
  'docx.format': '调整 Word 样式',
  'xlsx.create': '创建表格',
  'xlsx.edit': '写入表格内容',
  'xlsx.format_range': '调整表格样式',
  'pptx.create': '创建演示文稿',
  'pptx.edit': '修改演示文稿',
  'office.save': '保存文件',
  'office.export': '导出文件',
  'html.create': '创建网页文件',
  'pdf.create': '创建 PDF',
}
export function permissionCopy(permission) {
  const raw = String(permission.description || '')
  const tool = permission.toolName || raw.split(/[ ·\n]/, 1)[0]
  const generic = /^Confirm document change$/i.test(permission.title || '')
  return {
    title:
      permission.displayTitle ||
      tools[tool] ||
      (generic ? '确认文件修改' : permission.title) ||
      '核对这次操作',
    description:
      permission.displayDescription ||
      raw.replace(new RegExp('^' + tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*·?\\s*'), ''),
  }
}
