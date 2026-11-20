import { useId, useState } from 'react'
import type { TimelineWorkGroup, TimelineWorkStep } from './workspace-chat-timeline'
import {
  workspaceChatCopy,
  workspaceDisplayTitle,
  workspaceToolDisplayText,
  workspaceToolLabel,
  workspaceToolOutput,
  workspaceToolSummary,
} from './workspace-chat-strings'

function safeDisplayUrl(value: string): string | null {
  return /^(?:https?:|data:image\/(?:png|jpeg|webp);base64,)/i.test(value) ? value : null
}

function Step({ item, lang, running }: { item: TimelineWorkStep; lang: string; running: boolean }) {
  const copy = workspaceChatCopy(lang)
  if (item.kind === 'file') {
    const label =
      item.operation === 'read'
        ? copy.fileRead
        : item.operation === 'created'
          ? copy.fileCreated
          : copy.fileUpdated
    return (
      <div className="workspace-chat-file-activity">
        <span className="workspace-chat-file-activity-mark" aria-hidden="true">
          {item.operation === 'read' ? 'R' : item.operation === 'created' ? '+' : 'W'}
        </span>
        <span>{label}</span>
        <span className="workspace-chat-activity-summary" title={item.path}>
          {item.path}
        </span>
      </div>
    )
  }
  if (item.kind === 'plan') {
    return (
      <div className="workspace-chat-plan">
        <div className="workspace-chat-plan-title">{copy.plan}</div>
        <ol>
          {item.steps.map((step) => (
            <li className={step.status} key={step.id}>
              <span className="workspace-chat-plan-mark" aria-hidden="true" />
              <span>{step.title}</span>
            </li>
          ))}
        </ol>
      </div>
    )
  }
  const state = item.state === 'running' && !running ? 'stopped' : item.state
  return (
    <details className={'workspace-chat-activity ' + state}>
      <summary>
        <span className="workspace-chat-activity-mark" aria-hidden="true">
          {state === 'running' ? '…' : state === 'failed' ? '!' : state === 'stopped' ? '–' : '✓'}
        </span>
        <span>{workspaceToolLabel(item.name, lang)}</span>
        <span className="workspace-chat-activity-summary">
          {state === 'stopped'
            ? copy.workStopped
            : (workspaceToolSummary(item.summary, lang) ??
              (state === 'running' ? copy.toolRunning : ''))}
        </span>
      </summary>
      {item.display?.kind === 'images' && item.display.items?.length ? (
        <div className="workspace-chat-tool-images">
          {item.display.items.map((entry, index) => {
            const url = safeDisplayUrl(entry.url)
            return url ? (
              <img
                src={url}
                alt={workspaceDisplayTitle(entry.title, lang) ?? copy.toolResult(index + 1)}
                key={url + ':' + index}
              />
            ) : null
          })}
        </div>
      ) : null}
      {item.display?.kind === 'links' && item.display.items?.length ? (
        <div className="workspace-chat-tool-links">
          {item.display.items.map((entry, index) => {
            const url = safeDisplayUrl(entry.url)
            return url ? (
              <a href={url} target="_blank" rel="noreferrer" key={url + ':' + index}>
                {workspaceDisplayTitle(entry.title, lang) || url}
              </a>
            ) : null
          })}
        </div>
      ) : null}
      {item.display?.kind === 'text' && item.display.text ? (
        <pre>{workspaceToolDisplayText(item.display.text, lang)}</pre>
      ) : item.output ? (
        <pre>{workspaceToolOutput(item.output, lang)}</pre>
      ) : null}
    </details>
  )
}

export function WorkspaceToolSteps({ group, lang }: { group: TimelineWorkGroup; lang: string }) {
  const id = useId()
  const [manualOpen, setManualOpen] = useState<boolean>()
  const open = manualOpen ?? group.running
  const copy = workspaceChatCopy(lang)
  const tools = group.steps.filter((item) => item.kind === 'tool')
  const incomplete = tools.filter((item) => item.state !== 'completed').length
  const count = tools.length || group.steps.length
  const summary = group.running
    ? copy.workingSteps(count)
    : incomplete
      ? copy.incompleteSteps(count, incomplete)
      : copy.finishedSteps(count)
  return (
    <section className="workspace-chat-work-group">
      <button
        type="button"
        className="workspace-chat-work-summary"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setManualOpen(!open)}
      >
        <span className="workspace-chat-work-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {summary}
      </button>
      <div id={id} className="workspace-chat-work-steps" hidden={!open}>
        {open &&
          group.steps.map((item) => (
            <Step item={item} lang={lang} running={group.running} key={item.id} />
          ))}
      </div>
    </section>
  )
}
