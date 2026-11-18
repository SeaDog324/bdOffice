import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { assertZipInflatesWithinLimits } from '@genoffice/zip-gate'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  type PDFObject,
} from 'pdf-lib'
import type { ChangeLocation } from '../../shared/change-evidence'

interface PackageUnit {
  key: string
  location: ChangeLocation
  text: string
  data: unknown
}
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const name = (path: string) => path.split('/').at(-1) ?? path
const resource = (
  category: 'styles' | 'chart' | 'image' | 'layout' | 'pdf' | 'package',
  name: string,
  where?: { page?: number; slide?: number; sheet?: string },
): ChangeLocation => ({ kind: 'resource', category, name, ...where })
const xmlExcerpt = (value: string) => value.replace(/>\s+</g, '><').slice(0, 6_000)
function category(path: string): 'styles' | 'chart' | 'image' | 'layout' | 'package' {
  if (
    /(^|\/)(media|embeddings)\//i.test(path) ||
    /\.(png|jpe?g|gif|webp|svg|emf|wmf|tiff?)$/i.test(path)
  )
    return 'image'
  if (/(^|\/)charts\//i.test(path)) return 'chart'
  if (/(styles|theme|numbering|fontTable|tableStyles|font)\b/i.test(path)) return 'styles'
  if (/\/(drawings|slideLayouts|slideMasters|header|footer|worksheets|slides|document)/i.test(path))
    return 'layout'
  return 'package'
}
function imageSize(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return `${b.readUInt32BE(16)} × ${b.readUInt32BE(20)}`
  if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF')
    return `${b.readUInt16LE(6)} × ${b.readUInt16LE(8)}`
  return ''
}
function partSummary(
  path: string,
  bytes: Uint8Array,
  kind: ReturnType<typeof category>,
): { text: string; data: unknown } {
  const sha256 = digest(bytes),
    byteLength = bytes.byteLength
  if (kind === 'image')
    return {
      text: [name(path), imageSize(bytes), `${byteLength} bytes`, sha256.slice(0, 16)]
        .filter(Boolean)
        .join(' · '),
      data: { sha256, byteLength },
    }
  if (/\.(?:xml|rels)$/i.test(path)) {
    const xml = Buffer.from(bytes).toString('utf8')
    if (kind === 'chart') {
      const series = [...xml.matchAll(/<(?:\w+:)?ser(?=\s|>)/g)].length
      const values = [...xml.matchAll(/<(?:\w+:)?(?:v|f)\b[^>]*>([^<]{0,240})<\//g)]
        .slice(0, 24)
        .map((item) => item[1])
        .join(' · ')
      return {
        text: [name(path), `${series} series`, values].filter(Boolean).join(' · '),
        data: { sha256, byteLength, xml: xmlExcerpt(xml) },
      }
    }
    return { text: name(path), data: { sha256, byteLength, xml: xmlExcerpt(xml) } }
  }
  return { text: name(path), data: { sha256, byteLength } }
}

/** Complete package inventory, including unchanged and opaque parts. Never follows external relationships. */
export async function officePackageEvidence(bytes: Uint8Array): Promise<PackageUnit[]> {
  await assertZipInflatesWithinLimits(bytes, {
    maxParts: 12_000,
    maxPartBytes: 32 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
  })
  const archive = await JSZip.loadAsync(bytes)
  const units: PackageUnit[] = []
  for (const path of Object.keys(archive.files).sort()) {
    const part = archive.files[path]!
    if (part.dir) continue
    const payload = await part.async('uint8array'),
      kind = category(path)
    units.push({
      key: `part:${path}`,
      location: resource(kind, name(path)),
      ...partSummary(path, payload, kind),
    })
  }
  return units
}

/** PDF evidence covers page streams, resources, images, annotations, forms and catalog objects. */
export async function pdfPackageEvidence(bytes: Uint8Array): Promise<PackageUnit[]> {
  const document = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: true,
  })
  const context = document.context,
    memo = new Map<PDFObject, string>(),
    stack = new Set<PDFObject>()
  let visited = 0
  function fingerprint(object: PDFObject | undefined, depth = 0): string {
    if (!object) return 'absent'
    if (depth > 160 || ++visited > 240_000)
      throw new Error('PDF evidence exceeds the object budget.')
    if (stack.has(object)) return 'back-reference'
    const known = memo.get(object)
    if (known) return known
    stack.add(object)
    let result: string
    try {
      if (object instanceof PDFRef) result = fingerprint(context.lookup(object), depth + 1)
      else if (object instanceof PDFRawStream)
        result = digest(
          JSON.stringify([fingerprint(object.dict, depth + 1), digest(object.getContents())]),
        )
      else if (object instanceof PDFDict)
        result = digest(
          JSON.stringify(
            object
              .entries()
              .filter(([key]) => key.asString() !== '/Parent' && key.asString() !== '/P')
              .sort(([a], [b]) => a.asString().localeCompare(b.asString()))
              .map(([key, value]) => [key.asString(), fingerprint(value, depth + 1)]),
          ),
        )
      else if (object instanceof PDFArray)
        result = digest(
          JSON.stringify(object.asArray().map((value) => fingerprint(value, depth + 1))),
        )
      else result = digest(object.toString())
    } finally {
      stack.delete(object)
    }
    memo.set(object, result)
    return result
  }
  const units: PackageUnit[] = []
  const add = (
    key: string,
    location: ChangeLocation,
    text: string,
    object: PDFObject | undefined,
  ) => {
    if (object) units.push({ key, location, text, data: { sha256: fingerprint(object) } })
  }
  const pages = document.getPages()
  for (const [index, page] of pages.entries()) {
    const number = index + 1,
      prefix = `pdf:${number}:`,
      where = { page: number }
    add(
      prefix + 'page',
      resource('layout', 'Page geometry and resources', where),
      `${page.getWidth()} × ${page.getHeight()} · ${page.getRotation().angle}°`,
      page.node,
    )
    add(
      prefix + 'content',
      resource('pdf', 'Page content streams', where),
      'Page content',
      page.node.get(PDFName.of('Contents')),
    )
    const resources = page.node.Resources()
    add(
      prefix + 'resources',
      resource('layout', 'Page resources', where),
      'Fonts and graphics resources',
      resources,
    )
    const images = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    for (const [key, ref] of images?.entries() ?? []) {
      const object = context.lookup(ref)
      if (!(object instanceof PDFRawStream)) continue
      const subtype = object.dict.get(PDFName.of('Subtype'))?.toString(),
        label = key.decodeText()
      add(
        prefix + `object:${label}`,
        resource(subtype === '/Image' ? 'image' : 'layout', label, where),
        `${label} · ${object.getContents().byteLength} bytes · ${digest(object.getContents()).slice(0, 16)}`,
        object,
      )
    }
    for (const [offset, ref] of (page.node.Annots()?.asArray() ?? []).entries()) {
      const annotation = context.lookup(ref)
      if (!(annotation instanceof PDFDict)) continue
      const subtype =
        annotation.get(PDFName.of('Subtype'))?.toString().replace(/^\//, '') ?? 'Annotation'
      const value = annotation.get(PDFName.of('Contents')) ?? annotation.get(PDFName.of('V'))
      const description =
        value instanceof PDFString || value instanceof PDFHexString
          ? value.decodeText().slice(0, 1000)
          : subtype
      add(
        prefix + `annotation:${offset}`,
        resource('pdf', `${subtype} ${offset + 1}`, where),
        description,
        annotation,
      )
    }
  }
  add(
    'pdf:forms',
    resource('pdf', 'Form fields'),
    'Interactive form fields',
    document.catalog.get(PDFName.of('AcroForm')),
  )
  add(
    'pdf:catalog',
    resource('pdf', 'Document structure'),
    `${pages.length} pages`,
    document.catalog,
  )
  const objects = context.enumerateIndirectObjects()
  if (objects.length > 20_000) throw new Error('PDF evidence exceeds the object budget.')
  units.push({
    key: 'pdf:object-inventory',
    location: resource('pdf', 'Embedded objects'),
    text: `${objects.length} objects`,
    data: {
      sha256: digest(JSON.stringify(objects.map(([, object]) => fingerprint(object)).sort())),
    },
  })
  return units
}
