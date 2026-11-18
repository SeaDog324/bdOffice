import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { exportViaApp } from '@genoffice/cli/app-export'
/** Office rendering uses the existing headless editor against immutable artifact bytes. */
export function createMobilePreview(userData: string, appBinary?: string) {
  const pending = new Map<string, Promise<Buffer>>()
  return (name: string, bytes: Buffer) => {
    // eslint-disable-next-line no-control-regex -- Reject control bytes at the filesystem/auth boundary.
    if (/[\\/\x00-\x1f]/.test(name) || !/\.(docx|xlsx|pptx|md|html?)$/i.test(name))
      return Promise.reject(new Error('Unsupported preview'))
    const key = createHash('sha256').update(name).update(bytes).digest('hex')
    const existing = pending.get(key)
    if (existing) return existing
    const work = (async () => {
      const root = join(userData, 'mobile', 'previews')
      await mkdir(root, { recursive: true })
      const directory = await mkdtemp(join(root, 'view-'))
      try {
        const input = join(directory, name),
          output = join(directory, 'preview.pdf')
        await writeFile(input, bytes)
        await exportViaApp(input, 'pdf', output, {
          timeoutMs: 120_000,
          env: {
            ...process.env,
            // This module is bundled inside app.asar, not beside the CLI's wasm directory.
            ...(appBinary ? { GENOFFICE_APP_BIN: appBinary } : {}),
            GENOFFICE_USER_DATA: userData,
            GENOFFICE_ALLOWED_ROOTS: [directory].join(delimiter),
          },
        })
        return await readFile(output)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })().finally(() => pending.delete(key))
    pending.set(key, work)
    return work
  }
}
