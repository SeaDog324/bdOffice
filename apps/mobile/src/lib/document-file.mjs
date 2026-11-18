const mimeTypes = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}
const documentTypes = new Set(Object.values(mimeTypes))

export function documentFileType(artifact) {
  const mime = String(artifact?.mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const fromMime = mimeTypes[mime]
  if (fromMime) return fromMime
  const extension = String(artifact?.name || '')
    .split('.')
    .pop()
    .toLowerCase()
  return documentTypes.has(extension) ? extension : null
}

/** App's openDocument ignores fileType, so the local file must carry a safe extension. */
export async function ensureDocumentExtension(filePath, type, runtime, makeId) {
  if (!documentTypes.has(type) || typeof filePath !== 'string' || !filePath)
    throw new Error('UNSUPPORTED_DOCUMENT')
  if (filePath.toLowerCase().endsWith('.' + type)) return filePath
  if (!runtime?.io?.resolveLocalFileSystemURL) throw new Error('DOCUMENT_PATH_FAILED')
  const id = makeId()
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('DOCUMENT_PATH_FAILED')
  try {
    const entry = await new Promise((resolve, reject) =>
      runtime.io.resolveLocalFileSystemURL(filePath, resolve, reject),
    )
    const parent = await new Promise((resolve, reject) => entry.getParent(resolve, reject))
    const renamed = await new Promise((resolve, reject) =>
      entry.moveTo(parent, `bigdog-${id}.${type}`, resolve, reject),
    )
    const path = renamed.toLocalURL()
    if (typeof path !== 'string' || !path.toLowerCase().endsWith('.' + type))
      throw new Error('DOCUMENT_PATH_FAILED')
    return path
  } catch {
    throw new Error('DOCUMENT_PATH_FAILED')
  }
}
