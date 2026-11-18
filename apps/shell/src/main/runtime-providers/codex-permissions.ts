import { resolve } from 'node:path'
import type { JsonlAppServerClient } from './jsonl-client'

export const CODEX_TEXT_PERMISSION_PROFILE = 'bigdog-office-text'

/** No inherited :read-only profile: it permits reads across the filesystem. */
export function codexPermissionOverrides(
  workDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  // JSON string quoting is also valid TOML basic-string quoting for paths.
  // Pass each override as an argv element, never through a shell or config file.
  const path = JSON.stringify(resolve(workDir))
  return [
    `permissions.${CODEX_TEXT_PERMISSION_PROFILE}={filesystem={":root"="deny",":minimal"="read",${path}="read"},network={enabled=false}}`,
    `default_permissions="${CODEX_TEXT_PERMISSION_PROFILE}"`,
    'approval_policy="never"',
    // Office operations are client-owned dynamic tools, not native shell or
    // remote web tools. The restrictive profile remains the second boundary.
    'features.shell_tool=false',
    'features.unified_exec=false',
    'features.shell_snapshot=false',
    'web_search="disabled"',
    ...(platform === 'win32' ? ['windows.sandbox="elevated"'] : []),
  ]
}

/** Capability/requirements gate; never fall back to unrestricted legacy reads. */
export async function requireCodexPermissionProfile(
  client: Pick<JsonlAppServerClient, 'request'>,
  workDir: string,
): Promise<void> {
  let cursor: string | undefined
  const seen = new Set<string>()
  for (let page = 0; page < 32; page++) {
    const result = await client.request<{
      data?: Array<{ id?: string; allowed?: boolean }>
      nextCursor?: string | null
    }>('permissionProfile/list', { cwd: workDir, ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(result?.data)) throw new Error('Invalid Codex permission profile response.')
    const profile = result.data.find((entry) => entry.id === CODEX_TEXT_PERMISSION_PROFILE)
    if (profile) {
      if (profile.allowed !== true) {
        throw new Error(
          'The required BigDog read-restricted permission profile is blocked by Runtime policy.',
        )
      }
      return
    }
    if (!result.nextCursor || seen.has(result.nextCursor)) break
    cursor = result.nextCursor
    seen.add(cursor)
  }
  throw new Error(
    'Codex Runtime does not expose the required BigDog read-restricted permission profile. Update the Runtime; unrestricted fallback is disabled.',
  )
}

export function codexThreadParams(workDir: string) {
  return {
    cwd: workDir,
    approvalPolicy: 'never',
    permissions: CODEX_TEXT_PERMISSION_PROFILE,
    ephemeral: true,
  } as const
}

export function codexTurnParams(threadId: string, prompt: string, workDir: string) {
  return {
    threadId,
    input: [{ type: 'text', text: prompt }],
    cwd: workDir,
    approvalPolicy: 'never',
    permissions: CODEX_TEXT_PERMISSION_PROFILE,
  } as const
}
