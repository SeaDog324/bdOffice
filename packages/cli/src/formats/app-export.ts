import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

import { appLaunch } from '../resources'
import { CliError, EXIT } from '../result'

/**
 * Conversions that need an app renderer (Word, Excel and PowerPoint layout,
 * HTML and Markdown print, Word ↔ HTML) run in the BigDogOffice binary itself through its
 * `--headless-export` entry: Dock hidden, no window, one export, exit. bigdogoffice
 * just spawns it and reads the JSON envelope it prints. The app skips the
 * single-instance lock in that mode, so a running GUI does not interfere.
 */
export type AppExportTarget = 'pdf' | 'docx' | 'html'

export interface AppExportOptions {
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
  timeoutMs?: number
  /** how long a timed-out export gets to quit on SIGTERM before SIGKILL */
  killGraceMs?: number
  /** test seam */
  spawn?: typeof nodeSpawn
}

export interface AppExportResult {
  outputPath: string
  summary: string
}

const DEFAULT_TIMEOUT_MS = 300_000
export const MAX_EXPORT_STDIO_CHARS = 256 * 1024
const STDIO_DRAIN_MS = 500

export async function exportViaApp(
  input: string,
  target: AppExportTarget,
  outputPath: string,
  opts: AppExportOptions = {},
): Promise<AppExportResult> {
  if (opts.signal?.aborted) throw new CliError(EXIT.conversion, 'Export cancelled.')
  const env = opts.env ?? process.env
  const launch = appLaunch(env)
  if (!launch) {
    throw new CliError(EXIT.app, 'BigDogOffice app not found (needed for this conversion)', {
      hint: 'install BigDogOffice, or set GENOFFICE_APP_BIN to its executable',
    })
  }
  const args = [
    ...launch.args,
    '--headless-export',
    input,
    '--to',
    target,
    '--out',
    outputPath,
    '--json',
  ]
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  // A rendering worker must not start a second Remote Host or rotate its device credentials.
  for (const name of [
    'BIGDOG_REMOTE_CONFIG',
    'BIGDOG_MOBILE_DEV',
    'BIGDOG_MOBILE_PORT',
    'BIGDOG_MOBILE_PAIRING_CODE',
  ])
    delete childEnv[name]
  opts.log?.(`starting BigDogOffice for ${target} export`)
  const spawn = opts.spawn ?? nodeSpawn
  const child = spawn(launch.command, args, {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  const { code, signal, stdout, stderr, timedOut, cancelled } = await waitFor(
    child,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    opts.killGraceMs ?? 2000,
    opts.signal,
  )
  if (cancelled) throw new CliError(EXIT.conversion, 'Export cancelled.')
  const envelope = parseEnvelope(stdout)
  // The envelope is printed after the file is written and every teardown the
  // export owns is done; a crash or kill during Electron's own quit must not
  // turn a finished export into a failure.
  if (envelope?.status === 'ok' && existsSync(outputPath)) {
    if (timedOut) opts.log?.('export finished but BigDogOffice had to be terminated on quit')
    else if (code !== 0)
      opts.log?.(`export finished but BigDogOffice ${describeExit(code, signal)} while quitting`)
    return { outputPath, summary: envelope.summary ?? `exported to ${outputPath}` }
  }
  if (timedOut) {
    throw new CliError(
      EXIT.conversion,
      `BigDogOffice did not finish the export within ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s`,
      {
        app: launch.command,
      },
    )
  }
  const tail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(-4000)
  if (!envelope && (signal || code === null)) {
    throw new CliError(
      EXIT.app,
      `BigDogOffice ${describeExit(code, signal)} while exporting ${input}${tail ? `: ${tail}` : ''}`,
      { app: launch.command, exit_code: code, signal },
      {
        reason: 'app_crashed',
        suggestion:
          'retry once; if it crashes again, report it with the document and the crash log (macOS: ~/Library/Logs/DiagnosticReports)',
      },
    )
  }
  const message =
    envelope?.message ??
    envelope?.error ??
    envelope?.summary ??
    (tail ||
      (code === 0
        ? 'BigDogOffice exited without writing the file; this BigDogOffice version may not support --headless-export'
        : `BigDogOffice exited with code ${code}`))
  throw new CliError(exitCodeFor(code), message, {
    app: launch.command,
    exit_code: code,
  })
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `crashed (${signal})` : `exited with code ${code}`
}

/** The app's HEADLESS_EXIT codes: 1 bad args, 2 input error, 3 conversion failure. */
function exitCodeFor(
  code: number | null,
): typeof EXIT.file | typeof EXIT.conversion | typeof EXIT.app {
  if (code === 2) return EXIT.file
  if (code === 3 || code === 1) return EXIT.conversion
  return EXIT.app
}

export interface HeadlessEnvelope {
  status: 'ok' | 'error'
  summary?: string
  output_path?: string
  error?: string
  message?: string
}

/** Last JSON line on stdout; the app may log other lines before it. */
export function parseEnvelope(stdout: string): HeadlessEnvelope | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as HeadlessEnvelope
      if (parsed && (parsed.status === 'ok' || parsed.status === 'error'))
        return {
          status: parsed.status,
          ...(typeof parsed.summary === 'string' ? { summary: parsed.summary.slice(0, 4000) } : {}),
          ...(typeof parsed.output_path === 'string' ? { output_path: parsed.output_path } : {}),
          ...(typeof parsed.error === 'string' ? { error: parsed.error.slice(0, 4000) } : {}),
          ...(typeof parsed.message === 'string' ? { message: parsed.message.slice(0, 4000) } : {}),
        }
    } catch {}
  }
  return null
}

function waitFor(
  child: ChildProcess,
  timeoutMs: number,
  killGraceMs: number,
  signal?: AbortSignal,
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
}> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let cancelled = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (fn: () => void, delay: number) => {
      const t = setTimeout(() => {
        timers.delete(t)
        fn()
      }, delay)
      timers.add(t)
    }
    child.stdout?.on('data', (d) => (stdout = (stdout + String(d)).slice(-MAX_EXPORT_STDIO_CHARS)))
    child.stderr?.on('data', (d) => (stderr = (stderr + String(d)).slice(-MAX_EXPORT_STDIO_CHARS)))
    const finish = (code: number | null, processSignal: NodeJS.Signals | null = null) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      signal?.removeEventListener('abort', onAbort)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ code, signal: processSignal, stdout, stderr, timedOut, cancelled })
    }
    // On timeout: ask Electron to quit (it tears its children down), give it
    // a grace period, then kill; only report once the process is gone, so the
    // CLI never exits with a hung export still running.
    const kill = (force: boolean) => {
      try {
        if (process.platform === 'win32' && child.pid) {
          // This pid belongs to the process just spawned above, never a searched/global app.
          const killer = nodeSpawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.once('error', () => {
            try {
              child.kill('SIGKILL')
            } catch {}
          })
        } else if (child.pid && process.platform !== 'win32') {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
        } else child.kill(force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        try {
          child.kill(force ? 'SIGKILL' : 'SIGTERM')
        } catch {}
      }
    }
    const stop = () => {
      kill(false)
      later(() => {
        if (settled) return
        kill(true)
        later(() => finish(null), 1000)
      }, killGraceMs)
    }
    const onAbort = () => {
      if (settled || cancelled) return
      cancelled = true
      stop()
    }
    later(() => {
      if (!settled && !cancelled) {
        timedOut = true
        stop()
      }
    }, timeoutMs)
    child.once('error', (err) => {
      stderr = (stderr + `\n${err.message}`).slice(-MAX_EXPORT_STDIO_CHARS)
      finish(null)
    })
    child.once('close', (code, processSignal) => finish(code, processSignal))
    // `close` waits for every stdio handle to reach EOF, and Electron's renderer
    // and GPU helpers can hold the inherited pipes open after the main process
    // has printed the envelope and exited; settle shortly after `exit` instead.
    child.once('exit', (code, processSignal) =>
      later(() => finish(code, processSignal), STDIO_DRAIN_MS),
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
