import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function insidePath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** Resolve missing output leaves through their existing physical ancestor. */
export async function physicalUserPath(candidate: string): Promise<string> {
  const missing: string[] = []
  let current = resolve(candidate)
  while (true) {
    try {
      const parent = await realpath(current)
      return resolve(parent, ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/** Local structured tools may use user files; application stores require their domain APIs. */
export class LocalFileAccessPolicy {
  constructor(
    private readonly options: {
      protectedRoots: string[]
      ownedOutputRoots?: () => string[]
    },
  ) {}

  async resolve(requested: string, cwd: string): Promise<string> {
    if (
      typeof requested !== 'string' ||
      !requested ||
      requested.includes('\0') ||
      /^\\\\[.?]\\/.test(requested)
    )
      throw new Error('Invalid user file path.')
    if (!isAbsolute(requested) && requested.split(/[\\/]+/).includes('..'))
      throw new Error('Use an absolute path for a file outside the current folder.')
    const candidate = resolve(cwd, requested)
    if (process.platform === 'win32' && candidate.slice(2).includes(':'))
      throw new Error('Windows device paths and alternate data streams are not supported.')
    const full = await physicalUserPath(candidate)
    const protectedRoots = await Promise.all(this.options.protectedRoots.map(physicalUserPath))
    if (protectedRoots.some((root) => insidePath(root, full))) {
      const outputs = await Promise.all(
        (this.options.ownedOutputRoots?.() ?? []).map(physicalUserPath),
      )
      if (!outputs.some((root) => insidePath(root, full)))
        throw new Error('Use Session, memory or Settings tools to manage application data.')
    }
    return full
  }
}
