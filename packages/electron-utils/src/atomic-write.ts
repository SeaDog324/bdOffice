import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, open, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  publishSaveWitness,
  supportsSaveWitness,
  witnessBytes,
  witnessStagedFile,
} from './save-witness'

/** Transient Windows codes: antivirus/indexer briefly locks the rename target. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400]

/**
 * Codes a refused fsync may surface with inside cloud-sync folders, under AV
 * locks or on filesystems without fsync. The bytes are already written, so a
 * refused flush only weakens power-loss durability and must not fail the save.
 */
const TOLERATED_SYNC_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EINVAL', 'ENOSYS', 'ENOTSUP'])

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? ''
const isRetryableRename = (error: unknown) => RETRYABLE_RENAME_CODES.has(errorCode(error))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// No leading dot: the macOS SMB client marks dot-files hidden and the flag
// survives the rename onto the real document (genoffice#2145).
const tempPathBeside = (filePath: string) =>
  join(dirname(filePath), `${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)

const rescuePathFor = (filePath: string) =>
  join(dirname(filePath), `${basename(filePath)}.unsaved.tmp`)

/** Commit staged bytes or keep one named rescue copy when the target refuses a write. */
async function commitStagedFile(
  tmp: string,
  filePath: string,
  writeInPlace: () => Promise<void>,
  witness?: ReturnType<typeof witnessBytes>,
): Promise<void> {
  let usedFallback = false
  try {
    await renameWithRetry(tmp, filePath)
  } catch {
    try {
      await writeInPlace()
    } catch (error) {
      // A failed rescue rename leaves the completed staging bytes on disk.
      await renameWithRetry(tmp, rescuePathFor(filePath)).catch(() => {})
      throw error
    }
    usedFallback = true
  }
  publishSaveWitness(filePath, witness)
  if (usedFallback) await unlink(tmp).catch(() => {})
  await unlink(rescuePathFor(filePath)).catch(() => {})
}

async function syncFileBestEffort(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r+')
  } catch (error) {
    if (TOLERATED_SYNC_CODES.has(errorCode(error))) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!TOLERATED_SYNC_CODES.has(errorCode(error))) throw error
  } finally {
    await handle.close()
  }
}

function syncFileBestEffortSync(path: string): void {
  let descriptor: number
  try {
    descriptor = openSync(path, 'r+')
  } catch (error) {
    if (TOLERATED_SYNC_CODES.has(errorCode(error))) return
    throw error
  }
  try {
    fsyncSync(descriptor)
  } catch (error) {
    if (!TOLERATED_SYNC_CODES.has(errorCode(error))) throw error
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Same-dir temp file, best-effort fsync, then rename. Rename-over-existing fails
 * transiently on Windows (Defender/indexer locks: retry) and permanently on some
 * network mounts (gvfs SMB refuses with EEXIST, genoffice#1877); either way the
 * save falls back to an in-place write rather than failing.
 */
export async function atomicWriteFile(filePath: string, data: Buffer): Promise<void> {
  const witness = supportsSaveWitness(filePath) ? witnessBytes(data) : undefined
  const tmp = tempPathBeside(filePath)
  try {
    await writeFile(tmp, data)
    await syncFileBestEffort(tmp)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  await commitStagedFile(tmp, filePath, () => writeFile(filePath, data), witness)
}

async function renameWithRetry(tmp: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, filePath)
      return
    } catch (error) {
      if (!isRetryableRename(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      await sleep(RENAME_RETRY_DELAYS_MS[attempt] ?? 0)
    }
  }
}

/** copyFile stays in the kernel, so a multi-hundred-MB file is never read into RAM */
export async function atomicCopyFile(source: string, filePath: string): Promise<void> {
  const tmp = tempPathBeside(filePath)
  try {
    await copyFile(source, tmp)
    await syncFileBestEffort(tmp)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  await commitStagedFile(tmp, filePath, () => copyFile(tmp, filePath))
}

/**
 * The same contract for output that is produced as a stream rather than held
 * in one Buffer: `write` fills the sibling temp path (a large deck streams out
 * of JSZip chunk by chunk and never fits atomicWriteFile's single buffer), and
 * only a temp that `write` completed is synced and renamed over the target. A
 * writer that throws part-way leaves the target untouched, so a save that dies
 * mid-stream keeps the previous file on disk instead of a truncated one
 * (genoffice#2123).
 */
export async function atomicWriteVia(
  filePath: string,
  write: (tempPath: string) => Promise<void>,
): Promise<void> {
  const tmp = tempPathBeside(filePath)
  try {
    await write(tmp)
    await syncFileBestEffort(tmp)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  const witness = supportsSaveWitness(filePath) ? await witnessStagedFile(tmp) : undefined
  await commitStagedFile(tmp, filePath, () => copyFile(tmp, filePath), witness)
}

/**
 * Atomic replacement for small userData JSON state files (recents, stars, AI
 * settings). Same retry + in-place fallback as atomicWriteFile; the retry
 * sleeps block the caller, which is acceptable for a few KB under a transient
 * Windows lock.
 */
export function writeJsonAtomic(filePath: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const json = JSON.stringify(value, null, 2)
  const tmp = tempPathBeside(filePath)
  const removeTemp = () => {
    try {
      unlinkSync(tmp)
    } catch {
      /* temp never created */
    }
  }
  try {
    writeFileSync(tmp, json, { encoding: 'utf8', flag: 'wx', mode })
    syncFileBestEffortSync(tmp)
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, filePath)
        return
      } catch (error) {
        if (!isRetryableRename(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
        sleepSync(RENAME_RETRY_DELAYS_MS[attempt] ?? 0)
      }
    }
  } catch (error) {
    if (isRetryableRename(error)) {
      try {
        if (mode !== undefined && process.platform !== 'win32' && existsSync(filePath)) {
          chmodSync(filePath, mode)
        }
        writeFileSync(filePath, json, { encoding: 'utf8', mode })
      } finally {
        removeTemp()
      }
      return
    }
    removeTemp()
    throw error
  }
}

/** Repair the mode of existing credentials files before reading them. */
export function restrictFileToOwner(filePath: string): void {
  if (process.platform === 'win32') return
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Retain read compatibility with filesystems that do not support POSIX modes.
  }
}
