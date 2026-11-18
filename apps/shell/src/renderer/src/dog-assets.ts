import type { WorkspaceAgentEvent } from '../../shared/workspace-agent-api'
import dogClockout from './assets/dog/dog-clockout.png'
import dogDeadline from './assets/dog/dog-deadline.png'
import dogDone from './assets/dog/dog-done.png'
import dogFish from './assets/dog/dog-fish.png'
import dogHappy from './assets/dog/dog-happy.png'
import dogKeyboard from './assets/dog/dog-keyboard.png'
import dogMeeting from './assets/dog/dog-meeting.png'
import dogOffice from './assets/dog/dog-office.png'
import dogOvertime from './assets/dog/dog-overtime.png'
import dogPhone from './assets/dog/dog-phone.png'
import dogPlan from './assets/dog/dog-plan.png'
import dogPrint from './assets/dog/dog-print.png'
import dogReceived from './assets/dog/dog-received.png'
import dogReady from './assets/dog/dog-ready.png'
import dogReport from './assets/dog/dog-report.png'
import dogCoffee from './assets/dog/dog-coffee.png'

export type DogMood =
  'idle' | 'received' | 'thinking' | 'reading' | 'writing' | 'waiting' | 'complete' | 'error'

/** A short-lived visual event is separate from the broad workflow mood. */
export type DogEvent =
  | 'idle'
  | 'received'
  | 'thinking'
  | 'plan'
  | 'read'
  | 'report'
  | 'search'
  | 'inspect'
  | 'write'
  | 'save'
  | 'created'
  | 'ready'
  | 'approval'
  | 'waiting'
  | 'overtime'
  | 'coffee'
  | 'done'
  | 'happy'
  | 'clockout'
  | 'complete'
  | 'cancelled'
  | 'error'

export interface DogVisual {
  mood: DogMood
  frame: string
}

export const DOG_MOOD_FRAMES: Record<DogMood, string> = {
  // Each mood has one canonical frame. Event-specific frames below provide
  // richer feedback without any frame index or timer-driven carousel.
  idle: dogOffice,
  received: dogReceived,
  thinking: dogKeyboard,
  reading: dogReport,
  writing: dogPlan,
  waiting: dogOvertime,
  complete: dogClockout,
  error: dogDeadline,
}

export const DOG_MOOD_LABELS: Record<DogMood, string> = {
  idle: 'Ready when you are',
  received: 'Instruction received',
  thinking: 'Working through the request',
  reading: 'Reading workspace files',
  writing: 'Applying workspace changes',
  waiting: 'Waiting for your approval',
  complete: 'Workflow complete',
  error: 'Needs a quick check',
}

/** Canonical frame for every user-visible Agent lifecycle event. */
export const DOG_EVENT_VISUALS: Record<DogEvent, DogVisual> = {
  idle: { mood: 'idle', frame: dogOffice },
  received: { mood: 'received', frame: dogReceived },
  thinking: { mood: 'thinking', frame: dogKeyboard },
  plan: { mood: 'thinking', frame: dogPlan },
  read: { mood: 'reading', frame: dogReport },
  report: { mood: 'reading', frame: dogReport },
  search: { mood: 'reading', frame: dogPhone },
  inspect: { mood: 'reading', frame: dogReport },
  write: { mood: 'writing', frame: dogPlan },
  save: { mood: 'writing', frame: dogPrint },
  created: { mood: 'writing', frame: dogReady },
  ready: { mood: 'writing', frame: dogReady },
  approval: { mood: 'waiting', frame: dogMeeting },
  waiting: { mood: 'waiting', frame: dogOvertime },
  overtime: { mood: 'waiting', frame: dogOvertime },
  coffee: { mood: 'waiting', frame: dogCoffee },
  done: { mood: 'complete', frame: dogDone },
  happy: { mood: 'complete', frame: dogHappy },
  clockout: { mood: 'complete', frame: dogClockout },
  // Keep the original `complete` event stable for existing callers. New
  // terminal events use `done`/`happy` so the additional supplied artwork is
  // visible in the live stream without breaking older integrations.
  complete: { mood: 'complete', frame: dogClockout },
  cancelled: { mood: 'idle', frame: dogFish },
  error: { mood: 'error', frame: dogDeadline },
}

const DOG_EVENT_LABELS: Record<DogEvent, { zh: string; en: string }> = {
  idle: { zh: '准备就绪', en: 'Ready' },
  received: { zh: '收到你的指令', en: 'Instruction received' },
  thinking: { zh: '大狗正在思考', en: 'Thinking' },
  plan: { zh: '正在写方案', en: 'Drafting a plan' },
  read: { zh: '正在读取文件', en: 'Reading files' },
  report: { zh: '正在处理报表', en: 'Working on the report' },
  search: { zh: '正在查找信息', en: 'Searching' },
  inspect: { zh: '正在检查内容', en: 'Inspecting' },
  write: { zh: '正在写入修改', en: 'Applying changes' },
  save: { zh: '正在打印/保存文件', en: 'Saving the file' },
  created: { zh: '文件做好啦', en: 'File is ready' },
  ready: { zh: '文件做好啦', en: 'File is ready' },
  approval: { zh: '等待你的确认', en: 'Waiting for approval' },
  waiting: { zh: '正在等待', en: 'Waiting' },
  overtime: { zh: '大狗正在加班', en: 'Still working' },
  coffee: { zh: '送上一杯咖啡', en: 'A quick coffee break' },
  done: { zh: '完成', en: 'Done' },
  happy: { zh: '大狗很高兴', en: 'All done' },
  clockout: { zh: '下班打卡', en: 'Clocked out' },
  complete: { zh: '工作完成', en: 'Workflow complete' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  error: { zh: '需要检查', en: 'Needs attention' },
}

export function dogEventLabel(event: DogEvent, lang = 'en'): string {
  return /^zh(?:-|$)/iu.test(lang) ? DOG_EVENT_LABELS[event].zh : DOG_EVENT_LABELS[event].en
}

/** Match a tool call to the most useful event-specific artwork. */
export function dogEventForTool(name: string, mutated = false): DogEvent {
  const normalized = name.toLocaleLowerCase()

  // Terminal operations take precedence over broad mutation/read buckets.
  if (/(?:save|commit|persist|export|print)/u.test(normalized)) return 'save'
  if (/(?:create|new|generate|duplicate)/u.test(normalized)) return 'created'
  if (/(?:xlsx|excel|spreadsheet|sheet|range|cell|chart|report)/u.test(normalized)) {
    if (
      mutated ||
      /(?:edit|write|delete|remove|rename|update|format|insert|sort|filter)/u.test(normalized)
    )
      return 'report'
    if (/(?:inspect|metadata|stat|preview)/u.test(normalized)) return 'inspect'
    return 'report'
  }
  if (
    mutated ||
    /(?:edit|write|delete|remove|rename|update|command|apply|move|copy)/u.test(normalized)
  ) {
    return 'write'
  }
  if (/(?:search|list|find|query|glob|tree)/u.test(normalized)) return 'search'
  if (/(?:inspect|metadata|stat|render|preview)/u.test(normalized)) return 'inspect'
  if (/(?:read|get|open|context|file)/u.test(normalized)) return 'read'
  if (/(?:wait|poll|timeout|long)/u.test(normalized)) return 'waiting'
  return 'thinking'
}

/** Convert a durable Agent event into one deterministic mascot event. */
export function dogEventForAgentEvent(
  event: WorkspaceAgentEvent,
  current?: DogVisual,
): DogEvent | null {
  switch (event.type) {
    case 'assistant.message':
      return event.role === 'user' ? 'received' : 'thinking'
    case 'assistant.reasoning_summary':
      return 'thinking'
    case 'agent.plan':
      return 'plan'
    case 'tool.started': {
      const action = event.tool?.name ? dogEventForTool(event.tool.name) : 'thinking'
      // A create call beginning is work in progress, not a ready artifact.
      return action === 'created' ? 'write' : action
    }
    case 'tool.completed':
      return event.tool?.name
        ? dogEventForTool(event.tool.name, event.tool.mutated === true)
        : 'thinking'
    case 'tool.failed':
      return 'error'
    case 'file.read':
      return event.file?.type === 'xlsx' || event.file?.type === 'xlsm' ? 'report' : 'read'
    case 'file.modified':
      return event.file?.type === 'xlsx' || event.file?.type === 'xlsm' ? 'report' : 'write'
    case 'document.created':
      return 'ready'
    case 'permission.requested':
      return 'approval'
    case 'permission.resolved':
      return event.permission?.state === 'denied' ? 'error' : 'coffee'
    case 'agent.run.review':
      return event.run?.state === 'undo-failed'
        ? 'error'
        : event.run?.state === 'completed'
          ? 'happy'
          : 'cancelled'
    case 'error':
      return 'error'
    case 'agent.status':
      if (event.status === 'completed') return 'done'
      if (event.status === 'cancelled') return 'cancelled'
      if (event.status === 'error') return 'error'
      // A turn-end status is emitted while a file/tool frame is still the
      // most useful visual. Only the initial/idle status should switch to the
      // generic thinking frame.
      if (!current) return 'thinking'
      return current?.mood === 'idle' ||
        current?.mood === 'received' ||
        current?.mood === 'complete'
        ? 'thinking'
        : null
    default:
      return null
  }
}

export function dogVisualForEvent(event: DogEvent): DogVisual {
  return DOG_EVENT_VISUALS[event]
}
