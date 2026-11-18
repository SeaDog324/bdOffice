import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

export interface SaveWitness {
  id: string
  sha256: string
  byteLength: number
  at: number
  complete: boolean
}
const TYPES = new Set(['.docx', '.xlsx', '.xlsm', '.pptx', '.pdf', '.md', '.html', '.htm'])
const MAX_BYTES = 64 * 1024 * 1024
const witnessed = new Map<string, SaveWitness>()
const pathKey = (path: string) => {
  let physical = resolve(path)
  try {
    physical = realpathSync.native(physical)
  } catch {
    /* The target may not exist until promotion. */
  }
  return process.platform === 'win32' ? physical.toLowerCase() : physical
}
export const supportsSaveWitness = (path: string) => TYPES.has(extname(path).toLowerCase())
export function witnessBytes(bytes: Uint8Array, complete = true): SaveWitness | undefined {
  if (bytes.byteLength > MAX_BYTES) return
  return {
    id: randomUUID(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    at: Date.now(),
    complete,
  }
}
/** The writer owns this staging file. Read its expected bytes before promotion, never the final target. */
export async function witnessStagedFile(path: string): Promise<SaveWitness | undefined> {
  try {
    const before = await stat(path)
    if (!before.isFile() || before.size > MAX_BYTES) return
    const sha = createHash('sha256')
    let length = 0
    for await (const chunk of createReadStream(path, { end: MAX_BYTES })) {
      const bytes = chunk as Buffer
      length += bytes.byteLength
      if (length > MAX_BYTES) return
      sha.update(bytes)
    }
    const after = await stat(path)
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      return
    return {
      id: randomUUID(),
      sha256: sha.digest('hex'),
      byteLength: length,
      at: Date.now(),
      complete: true,
    }
  } catch {
    return undefined
  }
}
export function publishSaveWitness(path: string, witness: SaveWitness | undefined): void {
  if (!witness) return
  const key = pathKey(path)
  witnessed.delete(key)
  witnessed.set(key, { ...witness, at: Date.now() })
  while (witnessed.size > 200) witnessed.delete(witnessed.keys().next().value!)
}
export function saveWitness(path: string): SaveWitness | undefined {
  const value = witnessed.get(pathKey(path))
  return value && { ...value }
}
