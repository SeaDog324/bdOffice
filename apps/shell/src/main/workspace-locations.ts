import { opendir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { AgentToolDef } from '@genoffice/agent-core'
import type { WorkspaceFileEntry, WorkspaceFileType } from '../shared/workspace-agent-api'

export const WORKSPACE_LOCATIONS_KEY = 'workspaceLocations'
const MAX_LOCATIONS = 2048
export interface SavedWorkspaceLocation {
  path: string
  directory: boolean
}
export function savedWorkspaceLocations(value: unknown): SavedWorkspaceLocation[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_LOCATIONS)
    .filter(
      (item): item is SavedWorkspaceLocation =>
        !!item &&
        typeof item === 'object' &&
        typeof item.path === 'string' &&
        item.path.length <= 4096 &&
        isAbsolute(item.path) &&
        typeof item.directory === 'boolean',
    )
    .map(({ path, directory }) => ({ path, directory }))
}
export const locationKey = (path: string) =>
  process.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path
function locationType(path: string): WorkspaceFileType {
  const extension = extname(path).slice(1).toLowerCase()
  return [
    'docx',
    'pptx',
    'xlsx',
    'xlsm',
    'pdf',
    'txt',
    'md',
    'html',
    'csv',
    'json',
    'png',
    'jpg',
    'jpeg',
    'webp',
  ].includes(extension)
    ? (extension as WorkspaceFileType)
    : 'unknown'
}

export interface FindUserFilesRequest {
  query: string
  roots?: string[]
  kind?: 'file' | 'directory' | 'any'
  fileTypes?: string[]
  limit?: number
}

/** A discovery catalog. Access comes from the host's user-file policy, not membership here. */
export class WorkspaceLocationCatalog {
  constructor(
    private readonly options: {
      read(): unknown
      write(locations: SavedWorkspaceLocation[]): void
      sources(): readonly string[]
      searchRoots(): readonly string[]
      resolve(path: string): Promise<string>
      changed?(): void
      scanLimits?: { entries?: number; depth?: number; milliseconds?: number }
    },
  ) {}

  async inspect(paths: readonly string[]): Promise<WorkspaceFileEntry[]> {
    const entries = new Map<string, WorkspaceFileEntry>()
    for (const path of paths) {
      if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096)
        throw new Error('A file or folder needs a valid absolute path.')
      const full = await this.options.resolve(await realpath(path))
      const info = await stat(full)
      if (!info.isFile() && !info.isDirectory())
        throw new Error('Only files and folders can be registered.')
      entries.set(locationKey(full), {
        path: full,
        name: basename(full) || full,
        type: info.isDirectory() ? 'directory' : locationType(full),
        sizeBytes: info.isDirectory() ? 0 : info.size,
        mtimeMs: info.mtimeMs,
        directory: info.isDirectory(),
        registered: true,
      })
    }
    return [...entries.values()]
  }

  async register(paths: readonly string[]): Promise<WorkspaceFileEntry[]> {
    if (!paths.length || paths.length > 32)
      throw new Error('Register between 1 and 32 paths at a time.')
    const entries = await this.inspect(paths)
    // Read after validation so concurrent drops cannot overwrite one another.
    const stored = new Map(
      savedWorkspaceLocations(this.options.read()).map((entry) => [locationKey(entry.path), entry]),
    )
    for (const entry of entries)
      stored.set(locationKey(entry.path), { path: entry.path, directory: entry.directory })
    if (stored.size > MAX_LOCATIONS)
      throw new Error('The workspace location catalog is full. Remove an unused reference first.')
    this.options.write([...stored.values()])
    this.options.changed?.()
    return entries
  }

  async remove(path: string): Promise<void> {
    let full = path
    try {
      full = await this.options.resolve(path)
    } catch {
      /* A missing reference can still be removed. */
    }
    this.options.write(
      savedWorkspaceLocations(this.options.read()).filter(
        (entry) => locationKey(entry.path) !== locationKey(full),
      ),
    )
    this.options.changed?.()
  }

  async list(query = '', offset = 0, limit = 200) {
    const paths = [
      ...new Map(
        [
          ...this.options.sources(),
          ...savedWorkspaceLocations(this.options.read()).map((entry) => entry.path),
        ].map((path) => [locationKey(path), path]),
      ).values(),
    ]
    const needle = query.trim().toLocaleLowerCase()
    const matches = paths.filter((path) => !needle || path.toLocaleLowerCase().includes(needle))
    const start = Math.max(0, Math.trunc(offset)),
      size = Math.min(2048, Math.max(1, Math.trunc(limit)))
    const entries: WorkspaceFileEntry[] = [],
      unavailable: string[] = []
    for (const path of matches.slice(start, start + size)) {
      try {
        entries.push(...(await this.inspect([path])))
      } catch {
        unavailable.push(path)
      }
    }
    return {
      entries,
      unavailable,
      total: matches.length,
      offset: start,
      hasMore: start + size < matches.length,
      searchRoots: [...new Set(this.options.searchRoots())],
    }
  }

  async find(request: FindUserFilesRequest, signal: AbortSignal) {
    const query = request.query?.trim()
    if (!query || query.length > 200)
      throw new Error('Specify a filename or folder-name query under 200 characters.')
    if (request.roots && (!request.roots.length || request.roots.length > 16))
      throw new Error('Search up to 16 explicit roots at a time.')
    const limit = Math.max(1, Math.min(100, Math.trunc(request.limit ?? 30)))
    const roots = [
      ...new Map(
        (
          request.roots ?? [
            ...this.options.sources(),
            ...savedWorkspaceLocations(this.options.read()).map((entry) => entry.path),
            ...this.options.searchRoots(),
          ]
        ).map((path) => [locationKey(path), path]),
      ).values(),
    ]
    const patterns = query
      .toLocaleLowerCase()
      .split(/\s+/u)
      .map(
        (part) =>
          new RegExp(
            part
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/\?/g, '.'),
            'u',
          ),
      )
    const types = request.fileTypes?.map((type) => type.replace(/^\./, '').toLowerCase()) ?? []
    const kind = request.kind ?? 'file'
    const entries: WorkspaceFileEntry[] = [],
      unavailable: string[] = [],
      searchedRoots: string[] = []
    const visited = new Set<string>(),
      returned = new Set<string>(),
      reasons = new Set<string>()
    const queue: Array<{ path: string; depth: number }> = []
    const budget = this.options.scanLimits ?? {},
      started = Date.now()
    let examined = 0,
      skippedSymlinks = 0
    const stop = () => {
      signal.throwIfAborted()
      if (entries.length >= limit) reasons.add('result-limit')
      if (examined >= (budget.entries ?? 30000)) reasons.add('entry-limit')
      if (Date.now() - started >= (budget.milliseconds ?? 8000)) reasons.add('time-limit')
      return reasons.has('result-limit') || reasons.has('entry-limit') || reasons.has('time-limit')
    }
    const consider = async (path: string, directory: boolean) => {
      if ((kind === 'file' && directory) || (kind === 'directory' && !directory)) return
      if (!patterns.every((pattern) => pattern.test(basename(path).toLocaleLowerCase()))) return
      if (!directory && types.length && !types.includes(extname(path).slice(1).toLowerCase()))
        return
      const [entry] = await this.inspect([path])
      if (entry && !returned.has(locationKey(entry.path))) {
        returned.add(locationKey(entry.path))
        entries.push({ ...entry, registered: false })
      }
    }
    for (const root of roots) {
      if (stop()) break
      try {
        const [entry] = await this.inspect([root])
        if (!entry) continue
        searchedRoots.push(entry.path)
        await consider(entry.path, entry.directory)
        if (entry.directory) queue.push({ path: entry.path, depth: 0 })
      } catch {
        signal.throwIfAborted()
        unavailable.push(root)
      }
    }
    for (let position = 0; position < queue.length && !stop(); position++) {
      const { path, depth } = queue[position]!
      try {
        const full = await this.options.resolve(path),
          key = locationKey(full)
        if (visited.has(key)) continue
        visited.add(key)
        const dir = await opendir(full)
        for await (const child of dir) {
          if (stop()) break
          examined++
          if (child.isSymbolicLink()) {
            skippedSymlinks++
            continue
          }
          if (!child.isFile() && !child.isDirectory()) continue
          const candidate = join(full, child.name)
          try {
            await consider(candidate, child.isDirectory())
          } catch {
            signal.throwIfAborted()
          }
          if (child.isDirectory()) {
            if (depth >= (budget.depth ?? 24)) {
              reasons.add('depth-limit')
              continue
            }
            queue.push({ path: candidate, depth: depth + 1 })
          }
        }
      } catch {
        signal.throwIfAborted()
        if (unavailable.length < 100) unavailable.push(path)
      }
    }
    return {
      entries,
      searchedRoots,
      unavailable,
      examined,
      skippedSymlinks,
      truncated: reasons.size > 0,
      reasons: [...reasons],
      complete: reasons.size === 0 && unavailable.length === 0 && skippedSymlinks === 0,
    }
  }
}

export const WORKSPACE_LOCATION_TOOLS: AgentToolDef[] = [
  {
    name: 'workspace.locations',
    description:
      'Discover globally registered files, folders and project locations. These are live user path references, not memory or an access boundary. Use query/offset to find a named location before asking the user to provide a path.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.find_files',
    description:
      'Find local files or folders by name without reading their contents. Supports * and ? wildcards. Defaults to registered locations and Desktop/Documents/Downloads; roots can specify other absolute folders. Inspect searchedRoots, unavailable and truncated before claiming completeness. Use workspace.add_paths to retain relevant results in the global workspace, then list/read/edit with existing document tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        roots: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'string', minLength: 1, maxLength: 4096 },
        },
        kind: { type: 'string', enum: ['file', 'directory', 'any'] },
        fileTypes: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 30 } },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.add_paths',
    description:
      'Remember explicit file/folder paths in the global workspace for discovery across conversations. Adds references only; it does not copy, move, edit or delete the underlying files and does not widen OS permissions. Register relevant search results when the user wants to work with them.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
]
