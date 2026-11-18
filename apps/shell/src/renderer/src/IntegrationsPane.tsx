import { mcpLaunch, type McpLaunch } from '@genoffice/cli/mcp-launch'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n, type TFunc } from './locale'
import { settingsCopy } from './settings-copy'
import { McpServerSection } from './McpServerSection'
import type {
  AgentId,
  AgentTarget,
  IntegrationsStatus,
  SkillInstallState,
} from '../../shared/integrations-api'

// ── Settings → Integrations ─────────────────────────────────
// Installs the bundled `bigdogoffice` skill into the coding agents found on this
// machine. Every write starts with a click and shows the absolute path first,
// because the app does not see the shell's CODEX_HOME-style overrides and the
// user has to be able to spot a wrong target.

type AgentRow = AgentTarget & { state: SkillInstallState }

/** what the confirm block under a row is about */
interface Pending {
  kind: 'install' | 'uninstall'
  path: string
  /** extra warning line (overwriting edits, replacing a foreign SKILL.md) */
  note?: string
  target: { agentId: AgentId } | { dir: string }
  /** row the block renders under; the custom-folder install has none */
  agentId?: AgentId
}

/** some detected assistant holds an older copy of the skill than the bundled one */
export const skillUpdateDue = (s: IntegrationsStatus): boolean =>
  s.agents.some((a) => a.state.older === true)

const EXAMPLE_KEYS = ['intgExample1', 'intgExample2', 'intgExample3'] as const

export { mcpLaunch, type McpLaunch }

const shellWord = (w: string) => (/\s/.test(w) ? `"${w}"` : w)

/** `-e` is variadic in `claude mcp add`, so it goes before `--transport`, never right before the name. */
export function mcpClaudeCommand(launch: McpLaunch): string {
  const env = Object.entries(launch.env ?? {}).map(([k, v]) => `-e ${k}=${v} `)
  const words = [launch.command, ...launch.args].map(shellWord).join(' ')
  return `claude mcp add ${env.join('')}--transport stdio genoffice -- ${words}`
}

export function mcpConfigJson(launch: McpLaunch): string {
  const json = JSON.stringify({ mcpServers: { genoffice: launch } }, null, 2)
  return json.replace(/"args": \[[^\]]*\]/, `"args": ${JSON.stringify(launch.args)}`)
}

const api = () => window.aiOfficeIntegrations

export function IntegrationsPane({
  t,
  onStatus,
}: {
  t: TFunc
  onStatus?: (s: IntegrationsStatus) => void
}) {
  const copyText = settingsCopy(useI18n().lang)
  const [status, setStatus] = useState<IntegrationsStatus | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  /** one-line outcome shown until the next action: installed hint, saved zip path, copied */
  const [notice, setNotice] = useState<{
    agentId?: AgentId
    legacy?: boolean
    text: string
  } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [copying, setCopying] = useState<string | null>(null)
  const lock = useRef(false),
    copyLock = useRef(false)
  const statusListener = useRef(onStatus)
  statusListener.current = onStatus

  const refresh = useCallback(async () => {
    const s = await api()?.status()
    if (!s) throw new Error('integrations_unavailable')
    setStatus(s)
    setLoadError(false)
    statusListener.current?.(s)
  }, [])

  useEffect(() => {
    void refresh().catch(() => setLoadError(true))
  }, [refresh])

  const copy = async (text: string, key: string) => {
    if (copyLock.current) return
    copyLock.current = true
    setCopying(key)
    setCopied(null)
    setCopyError(false)
    try {
      if (!api()?.copyText) throw new Error('clipboard_unavailable')
      await api().copyText(text)
      setCopied(key)
    } catch {
      setCopyError(true)
    } finally {
      copyLock.current = false
      setCopying(null)
    }
  }

  const run = async () => {
    if (!pending || lock.current) return
    lock.current = true
    setBusy(true)
    try {
      if (pending.kind === 'install')
        await api()!.installSkill({ ...pending.target, replace: Boolean(pending.note) })
      else if ('agentId' in pending.target) await api()!.uninstallSkill(pending.target.agentId)
      setNotice(
        pending.kind === 'install' && !pending.agentId ? { text: t('intgInstalledHint') } : null,
      )
      setPending(null)
      await refresh()
    } catch (error) {
      setNotice({
        agentId: pending.agentId,
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  const askInstall = (row: AgentRow, note?: string) => {
    if (lock.current) return
    setNotice(null)
    setPending({
      kind: 'install',
      path: row.state.path,
      note,
      target: { agentId: row.id },
      agentId: row.id,
    })
  }

  const askUninstall = (row: AgentRow) => {
    if (lock.current) return
    setNotice(null)
    setPending({
      kind: 'uninstall',
      path: row.state.path,
      target: { agentId: row.id },
      agentId: row.id,
    })
  }

  const installElsewhere = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try {
      const dir = await api()?.pickSkillDir(t('intgPickDirTitle'))
      if (!dir) return
      setNotice(null)
      const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
      setPending({
        kind: 'install',
        path: `${dir}${sep}bigdogoffice${sep}SKILL.md`,
        target: { dir },
      })
    } catch {
      setNotice({ text: copyText.loadFailed })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  const downloadZip = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try {
      const path = await api()?.saveSkillZip(t('intgSaveZipTitle'))
      if (path) setNotice({ text: t('intgSavedTo', { path }) })
    } catch {
      setNotice({ text: copyText.saveFailed })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  const cleanLegacy = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try {
      const res = await api()!.sweepLegacySkillCopies()
      setNotice({
        legacy: true,
        text: t('intgLegacyCleaned', { n: res.removed.length, k: res.kept.length }),
      })
      await refresh()
    } catch (err) {
      setNotice({ legacy: true, text: t('intgLegacyFailed', { msg: String(err) }) })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  const confirmBlock = (p: Pending) => (
    <div className="set-intg-confirm" role="group">
      <div className="set-field-desc">
        {p.kind === 'install'
          ? t('intgConfirmWrite', { path: p.path })
          : t('intgConfirmRemove', { path: p.path })}
        {p.note ? ` ${p.note}` : ''}
      </div>
      <div className="set-intg-actions">
        <button className="set-btn" disabled={busy} onClick={() => setPending(null)}>
          {t('cancel')}
        </button>
        <button
          className="set-btn primary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void run()}
        >
          {busy ? copyText.working : t('intgConfirm')}
        </button>
      </div>
    </div>
  )

  if (!status) {
    return (
      <>
        <h3 className="set-pane-title">{t('setSecIntegrations')}</h3>
        <div className="set-field-desc" role={loadError ? 'alert' : 'status'}>
          {loadError ? copyText.loadFailed : t('intgLoading')}
        </div>
        {loadError && (
          <button
            className="set-btn"
            onClick={() => {
              setLoadError(false)
              void refresh().catch(() => setLoadError(true))
            }}
          >
            {copyText.retry}
          </button>
        )}
      </>
    )
  }

  /** the per-tool copies the shared `.agents` row replaced: still read, never updated */
  const legacy = status.legacy ?? []
  const launch = mcpLaunch(status.cli)
  const bundled = status.skillVersion
  const cliTooOld =
    status.skillNeedsCli &&
    status.cli.version &&
    compare(status.cli.version, status.skillNeedsCli) < 0
  const anyInstalled = status.agents.some((a) => a.state.status !== 'missing')

  return (
    <>
      <h3 className="set-pane-title">{t('setSecIntegrations')}</h3>

      <section className="set-intg-hero">
        <div className="set-intg-hero-title">{t('intgHeroTitle')}</div>
        <div className="set-field-desc">{copyText.integrationSummary}</div>
      </section>
      {copyError && (
        <p className="set-runtime-error" role="alert">
          {copyText.copyFailed}
        </p>
      )}
      <span className="set-sr-only" role="status">
        {copying ? copyText.working : copied ? copyText.copied : ''}
      </span>

      <h4 className="set-pane-subtitle set-intg-step">
        <span className="set-intg-step-no">1</span>
        {t('intgStep1Title')}
        <span className="set-intg-version">{t('intgSkillVersion', { v: bundled })}</span>
      </h4>
      <div className="set-field-desc set-intg-lead">
        {t('intgStep1Desc')} {t('intgStep1Update')}
      </div>
      {cliTooOld && (
        <div className="set-field-desc set-intg-warn">
          {t('intgCliNeedsUpdate', { v: status.skillNeedsCli })}
        </div>
      )}

      {status.agents.map((row) => {
        const { state } = row
        return (
          <div key={row.id} className="set-intg-row" data-agent={row.id} data-state={state.status}>
            <div className="set-field">
              <div className="set-field-text">
                <div className="set-field-stack">
                  <div className="set-field-label" title={row.label}>
                    {row.id === 'agents' ? copyText.sharedAgents : row.label}
                  </div>
                  {row.id === 'agents' && (
                    <div className="set-field-desc">{copyText.sharedAgentsHint}</div>
                  )}
                  <div className="set-field-desc set-intg-state" data-tip={state.path}>
                    {stateText(t, state, bundled)}
                  </div>
                </div>
              </div>
              <div className="set-intg-actions">
                {state.status === 'missing' && (
                  <button className="set-btn primary" onClick={() => askInstall(row)}>
                    {t('intgInstall')}
                  </button>
                )}
                {(state.status === 'outdated' || (state.status === 'foreign' && state.older)) && (
                  <button className="set-btn primary" onClick={() => askInstall(row)}>
                    {t('intgUpdate')}
                  </button>
                )}
                {state.status === 'modified' && (
                  <button
                    className="set-btn primary"
                    onClick={() => askInstall(row, t('intgConfirmOverwriteModified'))}
                  >
                    {t('intgUpdate')}
                  </button>
                )}
                {state.status === 'newer' && (
                  <button className="set-btn" onClick={() => askInstall(row)}>
                    {t('intgReinstall', { v: bundled })}
                  </button>
                )}
                {state.status === 'occupied' && (
                  <button
                    className="set-btn"
                    onClick={() => askInstall(row, t('intgConfirmOverwriteOccupied'))}
                  >
                    {t('intgOverwrite')}
                  </button>
                )}
                {(state.status === 'installed' ||
                  state.status === 'outdated' ||
                  state.status === 'modified') && (
                  <button className="set-btn" onClick={() => askUninstall(row)}>
                    {t('intgUninstall')}
                  </button>
                )}
              </div>
            </div>
            {pending?.agentId === row.id && confirmBlock(pending)}
            {notice?.agentId === row.id && (
              <div className="set-field-desc set-intg-notice">{notice.text}</div>
            )}
          </div>
        )
      })}

      {legacy.length > 0 && (
        <div className="set-intg-row" data-agent="legacy">
          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{t('intgLegacyTitle')}</div>
                <div className="set-field-desc">{t('intgLegacyDesc', { n: legacy.length })}</div>
                <ul className="set-intg-legacy">
                  {legacy.map((c) => (
                    <li key={c.path} className="set-intg-legacy-item">
                      {c.label} — {c.path}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="set-intg-actions">
              <button className="set-btn" disabled={busy} onClick={() => void cleanLegacy()}>
                {t('intgLegacyClean')}
              </button>
            </div>
          </div>
          {notice?.legacy && <div className="set-field-desc set-intg-notice">{notice.text}</div>}
        </div>
      )}

      <details className="set-intg-details" open={status.agents.length === 0}>
        <summary>{t('intgOtherToggle')}</summary>
        <div className="set-field-desc set-intg-lead">{t('intgOtherDesc')}</div>

        <div className="set-intg-option">
          <span className="set-intg-option-letter">A</span>
          <div className="set-field-stack">
            <div className="set-field-label">{t('intgOtherFolderTitle')}</div>
            <div className="set-field-desc">{t('intgOtherFolderDesc')}</div>
          </div>
          <button className="set-btn" disabled={busy} onClick={() => void installElsewhere()}>
            {t('intgInstallElsewhere')}
          </button>
        </div>

        <div className="set-intg-option">
          <span className="set-intg-option-letter">B</span>
          <div className="set-field-stack">
            <div className="set-field-label">{t('intgOtherZipTitle')}</div>
            <div className="set-field-desc">{t('intgOtherZipDesc')}</div>
          </div>
          <button className="set-btn" disabled={busy} onClick={() => void downloadZip()}>
            {t('intgDownloadZip')}
          </button>
        </div>

        {pending && !pending.agentId && confirmBlock(pending)}
        {notice && !notice.agentId && (
          <div className="set-field-desc set-intg-notice">{notice.text}</div>
        )}
      </details>

      <h4 className="set-pane-subtitle set-intg-step">
        <span className="set-intg-step-no">2</span>
        {t('intgStep2Title')}
      </h4>
      <div className="set-field-desc set-intg-lead">
        {anyInstalled ? t('intgStep2Desc') : t('intgStep2DescBefore')}
      </div>
      <div className="set-intg-examples">
        {EXAMPLE_KEYS.map((key) => (
          <div key={key} className="set-intg-example">
            <span className="set-intg-example-text">“{t(key)}”</span>
            <button
              className="set-btn"
              disabled={!!copying}
              aria-busy={copying === key}
              onClick={() => copy(t(key), key)}
            >
              {copied === key ? t('intgCopied') : t('intgCopy')}
            </button>
          </div>
        ))}
      </div>

      <details className="set-intg-details set-intg-cli">
        <summary>{t('intgCliTitle')}</summary>
        {!status.cli.ephemeral && status.cli.status !== 'present' && (
          <button
            className="set-btn"
            disabled={busy}
            onClick={async () => {
              if (lock.current) return
              lock.current = true
              setBusy(true)
              try {
                await api().installCli()
                await refresh()
              } catch (error) {
                setNotice({ text: error instanceof Error ? error.message : String(error) })
              } finally {
                lock.current = false
                setBusy(false)
              }
            }}
          >
            {t('intgCliEnable')}
          </button>
        )}
        <div className="set-field-desc set-intg-lead">
          {status.cli.ephemeral
            ? t('intgCliEphemeral')
            : status.cli.status === 'present'
              ? t('intgCliReady', { v: status.cli.version, path: status.cli.location ?? '' })
              : t('intgCliNotOnPath', { v: status.cli.version })}
        </div>
        {status.cli.status !== 'present' && status.cli.manual && !status.cli.ephemeral && (
          <div className="set-intg-code">
            <code>{status.cli.manual}</code>
            <button
              className="set-btn"
              disabled={!!copying}
              aria-busy={copying === 'manual'}
              onClick={() => copy(status.cli.manual!, 'manual')}
            >
              {copied === 'manual' ? t('intgCopied') : t('intgCopy')}
            </button>
          </div>
        )}
        <div className="set-field">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-desc">{t('intgCliLauncher')}</div>
              <div className="set-field-value set-intg-path" data-tip={status.cli.launcherDir}>
                {status.cli.launcherDir}
              </div>
            </div>
          </div>
          <div className="set-intg-actions">
            <button
              className="set-btn"
              disabled={!!copying}
              aria-busy={copying === 'path'}
              onClick={() => copy(status.cli.launcherDir, 'path')}
            >
              {copied === 'path' ? t('intgCopied') : t('intgCopyPath')}
            </button>
          </div>
        </div>
      </details>
      <details className="set-intg-details set-intg-mcp">
        <summary>{copyText.advancedMcp}</summary>
        <h5 className="set-intg-sub">
          <span className="set-intg-option-letter">A</span>
          {t('intgMcpStdioTitle')}
        </h5>
        <div className="set-field-desc set-intg-lead">{t('intgMcpStdioDesc')}</div>
        {status.cli.ephemeral ? (
          <div className="set-field-desc set-intg-lead">{t('intgCliEphemeral')}</div>
        ) : (
          <>
            <div className="set-intg-option">
              <div className="set-field-stack">
                <div className="set-field-label">{t('intgMcpClaudeTitle')}</div>
                <div className="set-field-desc">{t('intgMcpClaudeDesc')}</div>
                <div className="set-intg-code">
                  <code>{mcpClaudeCommand(launch)}</code>
                  <button
                    className="set-btn"
                    disabled={!!copying}
                    aria-busy={copying === 'mcp-claude'}
                    onClick={() => copy(mcpClaudeCommand(launch), 'mcp-claude')}
                  >
                    {copied === 'mcp-claude' ? t('intgCopied') : t('intgCopy')}
                  </button>
                </div>
              </div>
            </div>
            <div className="set-intg-option">
              <div className="set-field-stack">
                <div className="set-field-label">{t('intgMcpOtherTitle')}</div>
                <div className="set-field-desc">{t('intgMcpOtherDesc')}</div>
                <div className="set-intg-code set-intg-code-block">
                  <code>{mcpConfigJson(launch)}</code>
                  <button
                    className="set-btn"
                    disabled={!!copying}
                    aria-busy={copying === 'mcp-json'}
                    onClick={() => copy(mcpConfigJson(launch), 'mcp-json')}
                  >
                    {copied === 'mcp-json' ? t('intgCopied') : t('intgCopy')}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
        <div className="set-field-desc set-intg-lead">{t('intgMcpNote')}</div>
      </details>

      <details
        className="set-intg-details set-intg-mcp-http"
        onToggle={(event) => setMcpOpen(event.currentTarget.open)}
      >
        <summary>{t('intgMcpPartTitle')}</summary>
        <div className="set-field-desc set-intg-lead">{t('intgMcpPartDesc')}</div>
        {mcpOpen && <McpServerSection t={t} />}
      </details>
    </>
  )
}

function stateText(t: TFunc, state: SkillInstallState, bundled: string): string {
  const v = state.installedVersion ?? ''
  switch (state.status) {
    case 'missing':
      return t('intgStateMissing')
    case 'installed':
      return t('intgStateInstalled', { v })
    case 'outdated':
      return t('intgStateOutdated', { v, next: bundled })
    case 'modified':
      return t('intgStateModified', { v })
    case 'foreign':
      return t('intgStateForeign', { v })
    case 'newer':
      return t('intgStateNewer', { v })
    case 'occupied':
      return t('intgStateOccupied')
  }
}

function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}
