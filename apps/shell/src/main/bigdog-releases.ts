import { app } from 'electron'
import type { UpdateChannel } from '../shared/update-api'
import {
  BIGDOG_RELEASE_CATALOG_URL,
  BIGDOG_RELEASES_URL,
  bigDogReleasePage,
  type BigDogReleaseStatus,
} from '../shared/bigdog-release'

type Version = { core: string[]; pre: string[] }
function parseVersion(value: unknown): Version | null {
  if (typeof value !== 'string' || value.length > 80) return null
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    )
  if (!match) return null
  const pre = match[4]?.split('.') ?? []
  if (pre.some((id) => /^0\d+$/.test(id))) return null
  return { core: match.slice(1, 4), pre }
}

function numericCompare(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const diff = numericCompare(a.core[i], b.core[i])
    if (diff) return diff
  }
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i]
    if (x === undefined || y === undefined) return a.pre.length - b.pre.length
    if (x === y) continue
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y)
    if (xn && yn) return numericCompare(x, y)
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** GitHub metadata is a notification catalog, not an installer command. The
 * client never downloads or executes a binary from this response. */
export function selectBigDogRelease(
  catalog: unknown,
  current: string,
  channel: UpdateChannel,
  platform: string,
  arch: string,
): BigDogReleaseStatus {
  const installed = parseVersion(current)
  const releases = catalog
  if (!installed || !Array.isArray(releases)) throw new Error('Invalid release catalog')
  const target = ({ win32: 'windows', darwin: 'macos', linux: 'linux' } as Record<string, string>)[
    platform
  ]
  const formats =
    platform === 'win32' ? ['exe'] : platform === 'darwin' ? ['dmg'] : ['AppImage', 'deb', 'rpm']
  let latest: { version: string; parsed: Version } | null = null
  for (const item of releases) {
    const release = object(item)
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''
    const parsed = parseVersion(version)
    if (
      !parsed ||
      release.tag_name !== `v${version}` ||
      version.includes('+') ||
      release.draft !== false ||
      typeof release.prerelease !== 'boolean' ||
      (channel === 'stable' && release.prerelease) ||
      release.html_url !== bigDogReleasePage(version) ||
      typeof release.published_at !== 'string' ||
      !Number.isFinite(Date.parse(release.published_at))
    )
      continue
    if (channel === 'stable' && parsed.pre.length) continue
    if (!Array.isArray(release.assets) || !target || !['x64', 'arm64'].includes(arch)) continue
    const assets = release.assets.map(object)
    const uploaded = (name: string): boolean =>
      assets.some(
        (asset) =>
          asset.name === name &&
          asset.state === 'uploaded' &&
          typeof asset.size === 'number' &&
          Number.isSafeInteger(asset.size) &&
          asset.size > 0 &&
          typeof asset.digest === 'string' &&
          /^sha256:[a-f0-9]{64}$/.test(asset.digest) &&
          asset.browser_download_url === `${BIGDOG_RELEASES_URL}/download/v${version}/${name}`,
      )
    // Drafts and partially uploaded releases must not prompt users to update.
    if (!uploaded('release-manifest.json') || !uploaded('release-manifest.json.minisig')) continue
    const archs = platform === 'darwin' ? [arch, 'universal'] : [arch]
    if (
      !archs.some((cpu) =>
        formats.some((format) => {
          const name = `BigDogOffice-${version}-${target}-${cpu}.${format}`
          return uploaded(name) && uploaded(`${name}.minisig`)
        }),
      )
    )
      continue
    if (compare(parsed, installed) <= 0 || (latest && compare(parsed, latest.parsed) <= 0)) continue
    latest = { version, parsed }
  }
  return latest ? { phase: 'available', version: latest.version } : { phase: 'current' }
}

const pending = new Map<UpdateChannel, Promise<BigDogReleaseStatus>>()
export function checkBigDogRelease(channel: UpdateChannel): Promise<BigDogReleaseStatus> {
  const existing = pending.get(channel)
  if (existing) return existing
  const request = (async (): Promise<BigDogReleaseStatus> => {
    try {
      const response = await fetch(BIGDOG_RELEASE_CATALOG_URL, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (
        !response.ok ||
        !response.headers.get('content-type')?.includes('application/json') ||
        !response.body
      )
        throw new Error('Release request failed')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 1024 * 1024) throw new Error('Release catalog too large')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      return selectBigDogRelease(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        app.getVersion(),
        channel,
        process.platform,
        process.arch,
      )
    } catch {
      return { phase: 'error' }
    }
  })()
  pending.set(channel, request)
  void request.finally(() => pending.delete(channel))
  return request
}
