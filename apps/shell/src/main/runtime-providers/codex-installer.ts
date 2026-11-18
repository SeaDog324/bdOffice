import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import * as tar from 'tar'

const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const CODEX_PACKAGE_METADATA = `${NPM_REGISTRY_ORIGIN}/@openai%2Fcodex`
const MAX_RUNTIME_ARCHIVE_BYTES = 768 * 1024 * 1024

interface NpmPackageMetadata {
  version?: unknown
  optionalDependencies?: unknown
  dist?: {
    tarball?: unknown
    integrity?: unknown
  }
}

interface RuntimeManifest {
  version: string
  target: string
  executable: string
  installedAt: string
}

export interface RuntimeInstallation {
  executablePath: string
  version: string
  argsPrefix?: string[]
}

export interface RuntimeInstaller {
  detect(): Promise<boolean>
  current(): Promise<RuntimeInstallation | null>
  install(): Promise<RuntimeInstallation>
}

interface CodexTarget {
  optionalPackage: string
  target: string
  executable: string
}

/** Exact optional-package mapping published by the official @openai/codex package. */
export function codexTarget(platform = process.platform, arch = process.arch): CodexTarget {
  const key = `${platform}-${arch}`
  const targets: Record<string, CodexTarget> = {
    'win32-x64': {
      optionalPackage: '@openai/codex-win32-x64',
      target: 'x86_64-pc-windows-msvc',
      executable: 'codex.exe',
    },
    'win32-arm64': {
      optionalPackage: '@openai/codex-win32-arm64',
      target: 'aarch64-pc-windows-msvc',
      executable: 'codex.exe',
    },
    'darwin-x64': {
      optionalPackage: '@openai/codex-darwin-x64',
      target: 'x86_64-apple-darwin',
      executable: 'codex',
    },
    'darwin-arm64': {
      optionalPackage: '@openai/codex-darwin-arm64',
      target: 'aarch64-apple-darwin',
      executable: 'codex',
    },
    'linux-x64': {
      optionalPackage: '@openai/codex-linux-x64',
      target: 'x86_64-unknown-linux-musl',
      executable: 'codex',
    },
    'linux-arm64': {
      optionalPackage: '@openai/codex-linux-arm64',
      target: 'aarch64-unknown-linux-musl',
      executable: 'codex',
    },
  }
  const target = targets[key]
  if (!target) throw new Error(`Codex Runtime does not support ${platform}/${arch}.`)
  return target
}

function safeVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error('The official Codex package returned an invalid version.')
  }
  return value
}

function optionalVersion(value: unknown, packageName: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The official Codex package did not advertise a platform runtime.')
  }
  const spec = (value as Record<string, unknown>)[packageName]
  if (typeof spec !== 'string') {
    throw new Error(
      `The official Codex package does not support ${process.platform}/${process.arch}.`,
    )
  }
  const version = spec.startsWith('npm:@openai/codex@')
    ? spec.slice('npm:@openai/codex@'.length)
    : spec
  return safeVersion(version)
}

async function fetchJson(url: string, signal: AbortSignal): Promise<NpmPackageMetadata> {
  const response = await fetch(url, {
    signal,
    headers: { accept: 'application/json', 'user-agent': 'BigDogOffice-Runtime-Installer' },
  })
  if (!response.ok) throw new Error(`Runtime metadata request failed (${response.status}).`)
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runtime metadata was not a JSON object.')
  }
  return value as NpmPackageMetadata
}

function expectedSha512(integrity: unknown): Buffer {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error('The official runtime package is missing SHA-512 integrity metadata.')
  }
  const expected = Buffer.from(integrity.slice('sha512-'.length), 'base64')
  if (expected.byteLength !== 64) throw new Error('The runtime SHA-512 integrity is invalid.')
  return expected
}

function safeTarballUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('The runtime package has no download URL.')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== NPM_REGISTRY_ORIGIN) {
    throw new Error('The runtime package download URL is not the official npm registry.')
  }
  return url
}

async function downloadVerified(
  url: URL,
  integrity: unknown,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const expected = expectedSha512(integrity)
  const response = await fetch(url, {
    signal,
    headers: { accept: 'application/octet-stream', 'user-agent': 'BigDogOffice-Runtime-Installer' },
  })
  if (!response.ok || !response.body) {
    throw new Error(`Runtime download failed (${response.status}).`)
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_RUNTIME_ARCHIVE_BYTES) {
    throw new Error('The runtime package is larger than the safety limit.')
  }

  const output = createWriteStream(destination, { flags: 'wx' })
  const completion = finished(output)
  const hash = createHash('sha512')
  let total = 0
  try {
    for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(rawChunk)
      total += chunk.byteLength
      if (total > MAX_RUNTIME_ARCHIVE_BYTES) {
        throw new Error('The runtime package exceeded the safety limit while downloading.')
      }
      hash.update(chunk)
      if (!output.write(chunk)) await once(output, 'drain')
    }
    output.end()
    await completion
  } catch (error) {
    output.destroy()
    await completion.catch(() => {})
    throw error
  }
  if (!hash.digest().equals(expected)) throw new Error('Runtime package integrity check failed.')
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = `${resolve(parent)}${sep}`
  return resolve(child).startsWith(normalizedParent)
}

export class CodexRuntimeInstaller implements RuntimeInstaller {
  private readonly versionsDir: string
  private readonly manifestPath: string
  private installing: Promise<RuntimeInstallation> | null = null

  constructor(private readonly root: string) {
    this.versionsDir = join(root, 'versions')
    this.manifestPath = join(root, 'runtime.json')
  }

  async detect(): Promise<boolean> {
    return (await this.current()) !== null
  }

  async current(): Promise<RuntimeInstallation | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.manifestPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const manifest = parsed as Partial<RuntimeManifest>
      const version = safeVersion(manifest.version)
      const target = codexTarget()
      if (manifest.target !== target.target || typeof manifest.executable !== 'string') return null
      const executablePath = resolve(this.root, manifest.executable)
      if (!isInside(this.root, executablePath)) return null
      const info = await stat(executablePath)
      return info.isFile() ? { executablePath, version } : null
    } catch {
      return null
    }
  }

  install(): Promise<RuntimeInstallation> {
    this.installing ??= this.installLatest().finally(() => {
      this.installing = null
    })
    return this.installing
  }

  private async installLatest(): Promise<RuntimeInstallation> {
    await mkdir(this.versionsDir, { recursive: true })
    await this.removeStaleStagingDirectories()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10 * 60_000)
    let stagingRoot: string | null = null
    try {
      const target = codexTarget()
      const latest = await fetchJson(`${CODEX_PACKAGE_METADATA}/latest`, controller.signal)
      const releaseVersion = safeVersion(latest.version)
      const platformVersion = optionalVersion(latest.optionalDependencies, target.optionalPackage)
      const current = await this.current()
      if (current?.version === releaseVersion) {
        await this.removeOldVersions(releaseVersion).catch(() => {})
        return current
      }

      const metadata = await fetchJson(
        `${CODEX_PACKAGE_METADATA}/${encodeURIComponent(platformVersion)}`,
        controller.signal,
      )
      if (safeVersion(metadata.version) !== platformVersion) {
        throw new Error('The official runtime package version did not match its metadata URL.')
      }
      const tarball = safeTarballUrl(metadata.dist?.tarball)
      stagingRoot = await mkdtemp(join(this.root, '.codex-install-'))
      const archive = join(stagingRoot, 'runtime.tgz')
      const extracted = join(stagingRoot, 'package')
      await mkdir(extracted, { recursive: true })
      await downloadVerified(tarball, metadata.dist?.integrity, archive, controller.signal)
      await tar.x({
        file: archive,
        cwd: extracted,
        strip: 1,
        strict: true,
        preservePaths: false,
      })

      const sourceExecutable = join(extracted, 'vendor', target.target, 'bin', target.executable)
      if (!(await stat(sourceExecutable)).isFile()) {
        throw new Error('The downloaded Codex package does not contain its runtime executable.')
      }
      const canonicalExecutable = await realpath(sourceExecutable)
      if (!isInside(await realpath(extracted), canonicalExecutable)) {
        throw new Error('The downloaded Codex executable escaped its package directory.')
      }
      if (process.platform !== 'win32') await chmod(sourceExecutable, 0o755)

      const finalDir = join(this.versionsDir, releaseVersion)
      if (!isInside(this.versionsDir, finalDir)) throw new Error('Invalid runtime install target.')
      await rm(finalDir, { recursive: true, force: true })
      await rename(extracted, finalDir)
      const executablePath = join(finalDir, 'vendor', target.target, 'bin', target.executable)
      const manifest: RuntimeManifest = {
        version: releaseVersion,
        target: target.target,
        executable: executablePath.slice(resolve(this.root).length + 1),
        installedAt: new Date().toISOString(),
      }
      const tempManifest = join(this.root, `runtime.${process.pid}.tmp`)
      await writeFile(tempManifest, JSON.stringify(manifest, null, 2), { flag: 'w' })
      await rename(tempManifest, this.manifestPath)
      await this.removeOldVersions(releaseVersion).catch(() => {})
      return { executablePath, version: releaseVersion }
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error('Codex Runtime installation timed out.', { cause: error })
      throw error
    } finally {
      clearTimeout(timer)
      if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async removeOldVersions(activeVersion: string): Promise<void> {
    const entries = await readdir(this.versionsDir, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || entry.name === activeVersion) return
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(entry.name)) return
        const path = join(this.versionsDir, basename(entry.name))
        if (!isInside(this.versionsDir, path)) return
        await rm(path, { recursive: true, force: true })
      }),
    )
  }

  private async removeStaleStagingDirectories(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || !/^\.codex-install-[0-9A-Za-z_-]+$/u.test(entry.name)) return
        const path = join(this.root, basename(entry.name))
        if (!isInside(this.root, path)) return
        await rm(path, { recursive: true, force: true })
      }),
    )
  }
}
