/** Retry only Windows filesystem lock failures, never a document mutation. */
export async function retryAtomicRename(
  renameFile: () => Promise<void>,
  verifyUnchanged: () => Promise<void>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFile()
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (
        platform !== 'win32' ||
        attempt >= 5 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')
      )
        throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      await verifyUnchanged()
    }
  }
}
