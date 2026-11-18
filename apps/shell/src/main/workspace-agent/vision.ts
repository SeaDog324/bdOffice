import {
  activeProvider,
  defaultAiSettings,
  getProviderAdapter,
  modelLacksVision,
  resolveAiSettings,
  streamForProvider,
  type AiSettings,
} from '@genoffice/ai-provider'

export const MAX_PPTX_VISION_PATCHES = 12

export interface PptxVisionCheck {
  ok: boolean
  needsRepair: boolean
  issues: string[]
}

export interface PptxVisionElement {
  id: string
  type: string
  xRatio: number
  yRatio: number
  widthRatio: number
  heightRatio: number
  rotationDeg?: number
  text?: string
}

/** A deliberately small repair language. It cannot alter text, relationships,
 * media, themes, or OOXML; document adapters translate it to native edits. */
export interface PptxVisionRepairPatch {
  elementId: string
  xRatio?: number
  yRatio?: number
  widthRatio?: number
  heightRatio?: number
  fontSizePt?: number
}

export interface PptxVisionInspectInput {
  slide: number
  pngBase64: string
  width: number
  height: number
  signal?: AbortSignal
}

export interface PptxVisionRepairInput extends PptxVisionInspectInput {
  issues: string[]
  elements: PptxVisionElement[]
}

export class PptxVisionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PptxVisionUnavailableError'
  }
}

type VisionStream = typeof streamForProvider

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${keys.join(', ')}.`)
  }
}

function strictJson(text: string, label: string): unknown {
  const source = text.trim()
  if (!source) throw new Error(`${label} returned an empty response.`)
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new Error(`${label} must return one plain JSON object without Markdown or prose.`)
  }
}

function issueList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('Vision issues must be an array with at most 20 entries.')
  }
  return value.map((issue) => {
    if (typeof issue !== 'string' || !issue.trim()) {
      throw new Error('Every Vision issue must be a non-empty string.')
    }
    if (issue.length > 500) throw new Error('A Vision issue exceeds 500 characters.')
    return issue.trim()
  })
}

export function parsePptxVisionCheck(text: string): PptxVisionCheck {
  const value = recordValue(strictJson(text, 'PPTX Vision inspection'), 'Vision response')
  requireExactKeys(value, ['ok', 'needsRepair', 'issues'], 'Vision response')
  if (typeof value.ok !== 'boolean' || typeof value.needsRepair !== 'boolean') {
    throw new Error('Vision ok and needsRepair must be booleans.')
  }
  const issues = issueList(value.issues)
  if (value.ok && value.needsRepair) {
    throw new Error('A passing Vision result cannot request repair.')
  }
  if (!value.ok && value.needsRepair && issues.length === 0) {
    throw new Error('A requested Vision repair must include at least one issue.')
  }
  return { ok: value.ok, needsRepair: value.needsRepair, issues }
}

function ratioValue(value: unknown, name: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > 1) {
    throw new Error(`${name} must be a finite ratio between ${minimum} and 1.`)
  }
  return value
}

export function normalizePptxVisionRepairPatches(
  value: unknown,
  allowedElementIds?: ReadonlySet<string>,
): PptxVisionRepairPatch[] {
  if (!Array.isArray(value) || value.length > MAX_PPTX_VISION_PATCHES) {
    throw new Error(`Vision repair accepts at most ${MAX_PPTX_VISION_PATCHES} patches.`)
  }
  const seen = new Set<string>()
  return value.map((raw, index) => {
    const patch = recordValue(raw, `Vision patch ${index + 1}`)
    const allowedKeys = [
      'elementId',
      'xRatio',
      'yRatio',
      'widthRatio',
      'heightRatio',
      'fontSizePt',
    ]
    if (Object.keys(patch).some((key) => !allowedKeys.includes(key))) {
      throw new Error(`Vision patch ${index + 1} contains an unsupported field.`)
    }
    const elementId = typeof patch.elementId === 'string' ? patch.elementId.trim() : ''
    if (!elementId) throw new Error(`Vision patch ${index + 1} needs an elementId.`)
    if (allowedElementIds && !allowedElementIds.has(elementId)) {
      throw new Error(`Vision patch ${index + 1} targets an element outside the current slide.`)
    }
    if (seen.has(elementId)) throw new Error(`Vision repair contains duplicate element ${elementId}.`)
    seen.add(elementId)

    const xRatio = ratioValue(patch.xRatio, 'xRatio')
    const yRatio = ratioValue(patch.yRatio, 'yRatio')
    const widthRatio = ratioValue(patch.widthRatio, 'widthRatio', 0.005)
    const heightRatio = ratioValue(patch.heightRatio, 'heightRatio', 0.005)
    let fontSizePt: number | undefined
    if (patch.fontSizePt !== undefined) {
      if (
        typeof patch.fontSizePt !== 'number' ||
        !Number.isFinite(patch.fontSizePt) ||
        patch.fontSizePt < 6 ||
        patch.fontSizePt > 96
      ) {
        throw new Error('fontSizePt must be between 6 and 96 points.')
      }
      fontSizePt = patch.fontSizePt
    }
    if (
      xRatio === undefined &&
      yRatio === undefined &&
      widthRatio === undefined &&
      heightRatio === undefined &&
      fontSizePt === undefined
    ) {
      throw new Error(`Vision patch ${index + 1} does not change anything.`)
    }
    return {
      elementId,
      ...(xRatio === undefined ? {} : { xRatio }),
      ...(yRatio === undefined ? {} : { yRatio }),
      ...(widthRatio === undefined ? {} : { widthRatio }),
      ...(heightRatio === undefined ? {} : { heightRatio }),
      ...(fontSizePt === undefined ? {} : { fontSizePt }),
    }
  })
}

export function parsePptxVisionRepair(
  text: string,
  allowedElementIds?: ReadonlySet<string>,
): PptxVisionRepairPatch[] {
  const value = recordValue(strictJson(text, 'PPTX Vision repair'), 'Vision repair response')
  requireExactKeys(value, ['patches'], 'Vision repair response')
  return normalizePptxVisionRepairPatches(value.patches, allowedElementIds)
}

function configuredVisionProvider(readAiSettings: () => AiSettings) {
  let settings: AiSettings
  try {
    settings = resolveAiSettings(readAiSettings(), defaultAiSettings())
  } catch {
    throw new PptxVisionUnavailableError('AI settings could not be read for PPTX Vision.')
  }
  const provider = activeProvider(settings)
  const config = settings.providers[provider]
  if (!config?.apiKey) {
    throw new PptxVisionUnavailableError('Configure an AI provider key to enable PPTX Vision.')
  }
  if (!config.model) {
    throw new PptxVisionUnavailableError('Configure an AI model to enable PPTX Vision.')
  }
  const adapter = getProviderAdapter(provider)
  if (!adapter.capabilities.vision || modelLacksVision(config.model)) {
    throw new PptxVisionUnavailableError(
      `${provider}/${config.model} does not support image input for PPTX Vision.`,
    )
  }
  return { provider, config }
}

async function requestVisionJson(
  readAiSettings: () => AiSettings,
  stream: VisionStream,
  system: string,
  prompt: string,
  input: PptxVisionInspectInput,
  maxTokens: number,
): Promise<string> {
  if (!input.pngBase64.trim()) throw new Error('PPTX Vision received an empty PNG.')
  if (!Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.height) || input.height <= 0) {
    throw new Error('PPTX Vision received invalid image dimensions.')
  }
  const { provider, config } = configuredVisionProvider(readAiSettings)
  const controller = input.signal ? null : new AbortController()
  const signal = input.signal ?? controller!.signal
  let output = ''
  let stopReason = ''
  let unexpectedTool = false
  await stream(
    provider,
    config,
    system,
    [
      {
        role: 'user',
        text: prompt,
        images: [{ mime: 'image/png', base64: input.pngBase64 }],
      },
    ],
    [],
    maxTokens,
    {
      signal,
      onDelta: (text) => {
        output += text
        if (output.length > 200_000) throw new Error('PPTX Vision response is too large.')
      },
      onReasoningDelta: () => {},
      onToolCall: () => {
        unexpectedTool = true
      },
      onStopReason: (reason) => {
        stopReason = reason
      },
    },
  )
  if (unexpectedTool) throw new Error('PPTX Vision returned an unexpected tool call.')
  if (stopReason === 'max_tokens') throw new Error('PPTX Vision JSON was truncated.')
  return output
}

const INSPECTION_SYSTEM = `You inspect one rendered presentation slide for objective visual defects.
Return exactly one JSON object and no Markdown or prose:
{"ok":true,"needsRepair":false,"issues":[]}
Check clipping, overflow, accidental overlap, off-canvas content, unreadable contrast, and obviously broken image placement. Preserve intentional composition. Set needsRepair only when moving/resizing an existing top-level element or changing its font size can address the issue.`

const REPAIR_SYSTEM = `You produce a minimal repair plan for one rendered presentation slide.
Return exactly one JSON object and no Markdown or prose:
{"patches":[{"elementId":"id","xRatio":0.1,"yRatio":0.2,"widthRatio":0.4,"heightRatio":0.2,"fontSizePt":24}]}
Use only ids from the supplied top-level element inventory and at most 12 patches. Ratios are relative to the slide and must stay between 0 and 1. Font size must stay between 6 and 96 points. Omit unchanged fields. Do not change text, facts, colors, images, themes, groups, relationships, or OOXML. Return {"patches":[]} when the listed issue cannot be fixed safely with these fields.`

export function createPptxVisionCallbacks(
  readAiSettings: () => AiSettings,
  options: { stream?: VisionStream; inspectMaxTokens?: number; repairMaxTokens?: number } = {},
): {
  visionInspect(input: PptxVisionInspectInput): Promise<PptxVisionCheck>
  visionRepair(input: PptxVisionRepairInput): Promise<PptxVisionRepairPatch[]>
} {
  const stream = options.stream ?? streamForProvider
  return {
    async visionInspect(input) {
      const response = await requestVisionJson(
        readAiSettings,
        stream,
        INSPECTION_SYSTEM,
        `Inspect slide ${input.slide}. The PNG is ${input.width} by ${input.height} pixels.`,
        input,
        options.inspectMaxTokens ?? 800,
      )
      return parsePptxVisionCheck(response)
    },
    async visionRepair(input) {
      const elements = input.elements.slice(0, 200).map((element) => ({
        ...element,
        ...(element.text ? { text: element.text.slice(0, 300) } : {}),
      }))
      if (elements.length === 0) return []
      const allowedIds = new Set(elements.map((element) => element.id))
      const response = await requestVisionJson(
        readAiSettings,
        stream,
        REPAIR_SYSTEM,
        [
          `Repair slide ${input.slide}.`,
          `Issues: ${JSON.stringify(input.issues.slice(0, 20))}`,
          `Top-level elements: ${JSON.stringify(elements)}`,
        ].join('\n'),
        input,
        options.repairMaxTokens ?? 1_600,
      )
      return parsePptxVisionRepair(response, allowedIds)
    },
  }
}
