import type { CliRunRequest, CliRunResult } from '@genoffice/agent-core'

interface HomeCliBridge {
  kbRunCli(
    sessionId: string,
    request: CliRunRequest & { sources?: string[]; runId?: string },
  ): Promise<CliRunResult>
  kbCancelCli(runId: string): Promise<void>
}

export async function runHomeCliRequest(
  bridge: HomeCliBridge,
  sessionId: string,
  request: CliRunRequest & { sources?: string[] },
  signal?: AbortSignal,
): Promise<CliRunResult> {
  signal?.throwIfAborted()
  const runId = crypto.randomUUID()
  const cancel = () => {
    void bridge.kbCancelCli(runId).catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await bridge.kbRunCli(sessionId, { ...request, runId })
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
