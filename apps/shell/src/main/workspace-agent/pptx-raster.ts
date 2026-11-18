import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import type { OpenedPptx } from '@genoffice/pptx-engine'
import {
  buildRenderSlide,
  type RenderFill,
  type RenderNode,
  type RenderSlide,
  type ShapeRenderNode,
  type TableRenderNode,
  type ChartRenderNode,
  type PictureRenderNode,
} from '@genoffice/pptx-render'

export interface PptxRenderResult {
  slide: number
  mime: 'image/png'
  width: number
  height: number
  /** PNG bytes without a data URL prefix. */
  base64: string
  /** Explicit alias used by Agent/UI consumers. */
  pngBase64: string
  dataUrl: string
  text: string
  elementCount: number
  warnings: string[]
  /** Bounded top-level element inventory used by the Vision repair language. */
  elements?: Array<{
    id: string
    type: string
    xRatio: number
    yRatio: number
    widthRatio: number
    heightRatio: number
    rotationDeg?: number
    text?: string
  }>
  vision?: { status: 'not-configured' | 'passed' | 'needs-repair' | 'failed'; issues?: string[] }
  repaired?: boolean
}

interface CanvasContextLike {
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  font: string
  textBaseline: string
  globalAlpha: number
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  scale(x: number, y: number): void
  beginPath(): void
  closePath(): void
  rect(x: number, y: number, w: number, h: number): void
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  fill(): void
  stroke(): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  drawImage(image: unknown, ...args: number[]): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): {
    addColorStop(position: number, color: string): void
  }
}

interface CanvasLike {
  width: number
  height: number
  getContext(kind: '2d'): CanvasContextLike | null
  toBuffer(format?: string): Uint8Array
}

type CanvasModule = {
  createCanvas(width: number, height: number): CanvasLike
  loadImage?(source: string | Uint8Array): Promise<unknown>
}

let canvasModule: CanvasModule | null | undefined

function loadCanvasModule(): CanvasModule | null {
  if (canvasModule !== undefined) return canvasModule
  try {
    // Keep the native dependency optional for headless/test environments. The
    // deterministic PNG fallback still satisfies the render contract.
    const requireFromHere = createRequire(import.meta.url)
    canvasModule = requireFromHere('@napi-rs/canvas') as CanvasModule
  } catch {
    canvasModule = null
  }
  return canvasModule
}

function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'svg') return 'image/svg+xml'
  return 'image/png'
}

function color(value: unknown, fallback = '#FFFFFF'): string {
  if (typeof value !== 'string' || !value) return fallback
  return value.startsWith('#') ? value : `#${value}`
}

function fillCanvas(ctx: CanvasContextLike, fill: RenderFill, x: number, y: number, w: number, h: number): void {
  if (fill.kind === 'none') return
  if (fill.kind === 'solid') {
    ctx.fillStyle = color(fill.color)
    ctx.fillRect(x, y, w, h)
    return
  }
  if (fill.kind === 'gradient') {
    const angle = (fill.angleDeg * Math.PI) / 180
    const dx = Math.cos(angle) * w
    const dy = Math.sin(angle) * h
    const gradient = ctx.createLinearGradient(x, y, x + dx, y + dy)
    for (const stop of fill.stops) gradient.addColorStop(Math.max(0, Math.min(1, stop.pos)), color(stop.color))
    ctx.fillStyle = gradient
    ctx.fillRect(x, y, w, h)
    return
  }
  if (fill.kind === 'pattern') {
    ctx.fillStyle = color(fill.bg)
    ctx.fillRect(x, y, w, h)
    ctx.fillStyle = color(fill.fg)
    const size = Math.max(2, Math.round(fill.cellPx))
    for (let yy = y; yy < y + h; yy += size * 2) ctx.fillRect(x, yy, w, Math.max(1, size))
    return
  }
  // Image fills are handled by picture nodes when a media resolver is present;
  // a neutral background is preferable to a blank/transparent slide.
  ctx.fillStyle = '#F5F7FA'
  ctx.fillRect(x, y, w, h)
}

function drawText(ctx: CanvasContextLike, node: ShapeRenderNode, ox = 0, oy = 0): void {
  const layout = node.text
  if (!layout) return
  ctx.textBaseline = 'alphabetic'
  for (const line of layout.lines) {
    for (const run of line.runs) {
      if (run.isBullet) continue
      const weight = run.bold ? '700' : '400'
      const style = run.italic ? 'italic ' : ''
      ctx.font = `${style}${weight} ${Math.max(1, run.fontSizePx)}px ${JSON.stringify(run.fontFamily || 'Arial')}`
      ctx.fillStyle = color(run.color, '#111827')
      ctx.fillText(run.text, ox + run.x, oy + run.baselineY)
    }
  }
}

async function drawNode(ctx: CanvasContextLike, node: RenderNode, images: Map<string, string>): Promise<void> {
  if (node.type === 'group') {
    ctx.save()
    ctx.translate(node.box.x, node.box.y)
    for (const child of node.children) await drawNode(ctx, child, images)
    ctx.restore()
    return
  }
  const box = node.box
  ctx.save()
  ctx.translate(box.x + box.w / 2, box.y + box.h / 2)
  ctx.rotate((box.rotationDeg * Math.PI) / 180)
  ctx.scale(box.flipH ? -1 : 1, box.flipV ? -1 : 1)
  ctx.translate(-box.w / 2, -box.h / 2)
  if (node.type === 'shape' || node.type === 'text') {
    const shape = node as ShapeRenderNode
    fillCanvas(ctx, shape.fill, 0, 0, box.w, box.h)
    if (shape.line?.points?.length) {
      ctx.beginPath()
      const points = shape.line.points
      ctx.moveTo(points[0] ?? 0, points[1] ?? 0)
      for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i] ?? 0, points[i + 1] ?? 0)
      ctx.strokeStyle = color(shape.stroke?.color, '#334155')
      ctx.lineWidth = shape.stroke?.widthPx ?? 1
      ctx.stroke()
    } else if (shape.presetGeometry === 'ellipse' || shape.presetGeometry === 'ellipseRibbon') {
      ctx.beginPath()
      ctx.ellipse(box.w / 2, box.h / 2, Math.abs(box.w / 2), Math.abs(box.h / 2), 0, 0, Math.PI * 2)
      ctx.fill()
      if (shape.stroke) {
        ctx.strokeStyle = color(shape.stroke.color)
        ctx.lineWidth = shape.stroke.widthPx
        ctx.stroke()
      }
    } else {
      // Rectangular approximation for unsupported custom geometries keeps the
      // review image visibly non-empty and preserves text placement.
      if (shape.fill.kind !== 'none') fillCanvas(ctx, shape.fill, 0, 0, box.w, box.h)
      if (shape.stroke) {
        ctx.strokeStyle = color(shape.stroke.color)
        ctx.lineWidth = shape.stroke.widthPx
        ctx.strokeRect(0, 0, box.w, box.h)
      }
    }
    drawText(ctx, shape)
  } else if (node.type === 'picture') {
    const picture = node as PictureRenderNode
    if (picture.fill) fillCanvas(ctx, picture.fill, 0, 0, box.w, box.h)
    const dataUrl = picture.dataUrl ?? images.get(picture.sourceId)
    const canvas = loadCanvasModule()
    if (dataUrl && canvas?.loadImage) {
      try {
        const image = await canvas.loadImage(dataUrl)
        ctx.globalAlpha = picture.opacity ?? 1
        ctx.drawImage(image, 0, 0, box.w, box.h)
      } catch {
        ctx.fillStyle = '#E2E8F0'
        ctx.fillRect(0, 0, box.w, box.h)
      }
    } else {
      ctx.fillStyle = '#E2E8F0'
      ctx.fillRect(0, 0, box.w, box.h)
    }
    if (picture.stroke) {
      ctx.strokeStyle = color(picture.stroke.color)
      ctx.lineWidth = picture.stroke.widthPx
      ctx.strokeRect(0, 0, box.w, box.h)
    }
  } else if (node.type === 'table') {
    const table = node as TableRenderNode
    if (table.bgFill) fillCanvas(ctx, table.bgFill, 0, 0, box.w, box.h)
    for (const cell of table.cells) {
      fillCanvas(ctx, cell.fill, cell.x, cell.y, cell.w, cell.h)
      ctx.strokeStyle = '#CBD5E1'
      ctx.lineWidth = 1
      ctx.strokeRect(cell.x, cell.y, cell.w, cell.h)
      if (cell.text) {
        const faux = { ...node, type: 'text', box: { ...box, x: 0, y: 0, w: cell.w, h: cell.h }, text: cell.text, fill: { kind: 'none' } } as ShapeRenderNode
        drawText(ctx, faux, cell.x, cell.y)
      }
    }
  } else if (node.type === 'chart') {
    const chart = node as ChartRenderNode
    if (chart.bgFill) fillCanvas(ctx, chart.bgFill, 0, 0, box.w, box.h)
    for (const bar of chart.bars) {
      ctx.fillStyle = color(bar.color, '#2563EB')
      ctx.fillRect(bar.x, bar.y, bar.w, bar.h)
    }
    for (const line of chart.polylines ?? []) {
      if (line.points.length < 4) continue
      ctx.beginPath()
      ctx.moveTo(line.points[0] ?? 0, line.points[1] ?? 0)
      for (let i = 2; i < line.points.length; i += 2) ctx.lineTo(line.points[i] ?? 0, line.points[i + 1] ?? 0)
      ctx.strokeStyle = color(line.color, '#2563EB')
      ctx.lineWidth = line.widthPx || 1
      ctx.stroke()
    }
    for (const label of chart.labels) {
      ctx.font = `${label.bold ? '700 ' : ''}${label.fontSizePx || 12}px Arial`
      ctx.fillStyle = color(label.color, '#334155')
      ctx.fillText(label.text, label.x, label.y)
    }
  }
  ctx.restore()
}

function textOfSlide(slide: RenderSlide): string {
  const out: string[] = []
  const walk = (node: RenderNode) => {
    if (node.type === 'group') return node.children.forEach(walk)
    if (node.type === 'shape' || node.type === 'text') {
      for (const line of node.text?.lines ?? []) out.push(line.runs.filter((run) => !run.isBullet).map((run) => run.text).join(''))
    }
    if (node.type === 'table') {
      for (const cell of node.cells) for (const line of cell.text?.lines ?? []) out.push(line.runs.map((run) => run.text).join(''))
    }
    if (node.type === 'chart') out.push(...node.labels.map((label) => label.text))
  }
  slide.nodes.forEach(walk)
  return out.filter(Boolean).join('\n')
}

function textOfNode(node: RenderNode): string {
  if (node.type === 'group') return node.children.map(textOfNode).filter(Boolean).join('\n')
  if (node.type === 'shape' || node.type === 'text') {
    return (node.text?.lines ?? [])
      .map((line) => line.runs.filter((run) => !run.isBullet).map((run) => run.text).join(''))
      .filter(Boolean)
      .join('\n')
  }
  if (node.type === 'table') {
    return node.cells
      .flatMap((cell) =>
        (cell.text?.lines ?? []).map((line) => line.runs.map((run) => run.text).join('')),
      )
      .filter(Boolean)
      .join(' | ')
  }
  if (node.type === 'chart') return node.labels.map((label) => label.text).filter(Boolean).join('\n')
  return ''
}

function topLevelElements(render: RenderSlide): NonNullable<PptxRenderResult['elements']> {
  const width = Math.max(1, render.widthPx)
  const height = Math.max(1, render.heightPx)
  return render.nodes.slice(0, 200).map((node) => ({
    id: node.sourceId,
    type: node.type,
    xRatio: node.box.x / width,
    yRatio: node.box.y / height,
    widthRatio: node.box.w / width,
    heightRatio: node.box.h / height,
    ...(Number.isFinite(node.box.rotationDeg) ? { rotationDeg: node.box.rotationDeg } : {}),
    ...(textOfNode(node) ? { text: textOfNode(node).slice(0, 300) } : {}),
  }))
}

function mediaMap(opened: OpenedPptx): Map<string, string> {
  const result = new Map<string, string>()
  for (const [path, bytes] of opened.archive.entries) {
    if (!path.startsWith('ppt/media/')) continue
    result.set(path, `data:${mimeForPath(path)};base64,${Buffer.from(bytes).toString('base64')}`)
  }
  return result
}

/** Render a parsed slide to a PNG review artifact. */
export async function renderPptxSlide(
  opened: OpenedPptx,
  slideNumber: number,
  options: { width?: number } = {},
): Promise<PptxRenderResult> {
  const slide = opened.deck.slides[slideNumber - 1]
  if (!slide) throw new Error(`Slide ${slideNumber} does not exist.`)
  const images = mediaMap(opened)
  const width = Math.max(320, Math.min(Math.trunc(options.width ?? 1280), 2400))
  const render = buildRenderSlide(slide, opened.deck.size, {
    fitWidthPx: width,
    media: (ref) => images.get(ref),
    slideNo: slideNumber,
  })
  return renderRenderSlide(render, slideNumber, images, width)
}

/** Render an already-built RenderSlide (used by an open Slides renderer). */
export async function renderRenderSlide(
  render: RenderSlide,
  slideNumber: number,
  images: Map<string, string> = new Map(),
  requestedWidth = render.widthPx,
): Promise<PptxRenderResult> {
  const width = Math.max(320, Math.min(Math.trunc(requestedWidth || render.widthPx), 2400))
  const scale = width / Math.max(1, render.widthPx)
  const height = Math.max(180, Math.round(render.heightPx * scale))
  const canvas = loadCanvasModule()?.createCanvas(width, height)
  let bytes: Uint8Array
  const warnings: string[] = []
  if (canvas) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The PNG renderer could not create a 2D context.')
    ctx.scale(scale, scale)
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, render.widthPx, render.heightPx)
    fillCanvas(ctx, render.background, 0, 0, render.widthPx, render.heightPx)
    for (const node of render.nodes) await drawNode(ctx, node, images)
    bytes = canvas.toBuffer('image/png')
  } else {
    warnings.push('Native canvas unavailable; returned a deterministic preview raster.')
    bytes = fallbackPng(width, height, render.background)
  }
  const base64 = Buffer.from(bytes).toString('base64')
  return {
    slide: slideNumber,
    mime: 'image/png',
    width,
    height,
    base64,
    pngBase64: base64,
    dataUrl: `data:image/png;base64,${base64}`,
    text: textOfSlide(render),
    elementCount: countNodes(render.nodes),
    warnings,
    elements: topLevelElements(render),
  }
}

function countNodes(nodes: readonly RenderNode[]): number {
  return nodes.reduce((count, node) => count + 1 + (node.type === 'group' ? countNodes(node.children) : 0), 0)
}

// Minimal RGBA PNG encoder used only when the optional native canvas is not
// available (for example in a CI worker without native binaries).
function fallbackPng(width: number, height: number, background: RenderFill): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  const hex = background.kind === 'solid' ? color(background.color).replace('#', '') : 'F5F7FA'
  const r = parseInt(hex.slice(0, 2) || 'F5', 16)
  const g = parseInt(hex.slice(2, 4) || 'F7', 16)
  const b = parseInt(hex.slice(4, 6) || 'FA', 16)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Number.isFinite(r) ? r : 245
    rgba[i + 1] = Number.isFinite(g) ? g : 247
    rgba[i + 2] = Number.isFinite(b) ? b : 250
    rgba[i + 3] = 255
  }
  const scan = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    scan[y * (width * 4 + 1)] = 0
    scan.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  return concatBytes(
    signature,
    pngChunk('IHDR', uint32(width), uint32(height), new Uint8Array([8, 6, 0, 0, 0])),
    pngChunk('IDAT', deflateSync(scan)),
    pngChunk('IEND', new Uint8Array()),
  )
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
}

function pngChunk(type: string, data: Uint8Array, ...extra: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(data.length + extra.reduce((n, item) => n + item.length, 0))
  bytes.set(data)
  let offset = data.length
  for (const item of extra) {
    bytes.set(item, offset)
    offset += item.length
  }
  const tag = Buffer.from(type, 'ascii')
  const body = new Uint8Array(tag.length + bytes.length)
  body.set(tag)
  body.set(bytes, tag.length)
  const crc = crc32(body)
  return concatBytes(uint32(bytes.length), tag, bytes, uint32(crc))
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
