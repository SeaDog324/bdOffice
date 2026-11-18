import type { Editor } from '@tiptap/core'
import { executeOps, type Op } from './ops'

/**
 * Structured edit commands: the model emits a
 * batchUpdate-style JSON envelope and code applies it deterministically on the
 * PM doc — one transaction per envelope, so one undo reverts the whole round.
 * The docx round trip is untouched: changed nodes become dirty via the normal
 * signature comparison and regenerate on save; docxIndex anchors are never
 * modified here.
 */

// ---- command types (§4) ----

/** All given conditions filter with AND; at least one condition is required */
export interface Target {
  /** 'image' matches protected image blocks (docProtected + blockType image) */
  nodeType?: 'docHeading' | 'docParagraph' | 'docListItem' | 'image'
  /** Restrict heading level (only with nodeType: 'docHeading') */
  headingLevel?: number
  /** The block's plain text contains this substring (case-sensitive unless matchCase: false) */
  containsText?: string
  matchCase?: boolean
  /** By block index (the index output by buildDocumentContext, 0-based, current PM doc top-level order) */
  blockIndexes?: number[]
  /** 'selection' = only blocks covered by the current selection; default = whole document */
  scope?: 'selection' | 'document'
}

/** Run-level style; only keys listed in fields take effect, and null clears the property */
export interface UpdateTextStyle {
  target: Target
  style: {
    color?: string | null
    highlight?: string | null
    sizeHalfPoints?: number | null
    font?: string | null
    bold?: boolean
    italic?: boolean
    underline?: boolean
    strike?: boolean
    /** Super/subscript (enum values aligned with Google TextStyle.baselineOffset) */
    baselineOffset?: 'SUPERSCRIPT' | 'SUBSCRIPT' | 'NONE' | null
    /** Hyperlink (aligned with Google TextStyle.link); null removes the link */
    link?: { url: string } | null
  }
  fields: Array<keyof UpdateTextStyle['style']>
}

/** Paragraph-level format; likewise constrained by the fields mask */
export interface UpdateParagraphStyle {
  target: Target
  style: {
    align?: 'left' | 'center' | 'right' | 'justify' | null
    lineSpacing?: number | null
    indentLeft?: number | null
    indentRight?: number | null
    /** First-line indent in twips; positive = first-line indent, negative = hanging indent (aligned with Google indentFirstLine) */
    indentFirstLine?: number | null
    spaceBefore?: number | null
    spaceAfter?: number | null
    pageBreakBefore?: boolean
    shadingFill?: string | null
    /** Paragraph borders, a subset of "tblr" (simplified Google borderTop/Bottom/Left/Right) */
    borders?: string | null
  }
  fields: Array<keyof UpdateParagraphStyle['style']>
}

/** Paragraph promote/demote; level 0 = demote to body paragraph, 1-6 = the corresponding heading level */
export interface SetHeadingLevel {
  target: Target
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6
}

/** Find & replace (plain text, no cross-block matching); target narrows the scanned blocks */
export interface ReplaceAllText {
  containsText: string
  replaceText: string
  matchCase?: boolean
  /** omitted = whole document */
  target?: Target
}

/**
 * Character-level styling: applies the run style only to the matched text
 * itself (updateTextStyle always styles whole blocks). target narrows which
 * blocks are scanned; omitted = whole document.
 */
export interface UpdateMatchedTextStyle {
  containsText: string
  matchCase?: boolean
  target?: Target
  style: UpdateTextStyle['style']
  fields: Array<keyof UpdateTextStyle['style']>
}

export interface DeleteBlocks {
  target: Target
}

/** Move the blocks in blockIndexes (relative order kept) after afterBlockIndex; -1 = document start */
export interface MoveBlocks {
  blockIndexes: number[]
  afterBlockIndex: number
}

/**
 * Paragraphs to list (name and semantics aligned with Google's createParagraphBullets).
 * BULLET*-prefixed presets = unordered, NUMBERED* = ordered; heading blocks aren't converted (counted in matched but unchanged).
 */
export interface CreateParagraphBullets {
  target: Target
  bulletPreset?: string
}

/** List items back to body paragraphs (aligned with Google's deleteParagraphBullets) */
export interface DeleteParagraphBullets {
  target: Target
}

/** Image block properties; giving only one of widthPx/heightPx scales the other side by the original ratio */
export interface UpdateImageProperties {
  target: Target
  properties: {
    widthPx?: number | null
    heightPx?: number | null
    align?: 'left' | 'center' | 'right' | null
  }
  fields: Array<keyof UpdateImageProperties['properties']>
}

/**
 * Insert a TOC field after the given block (a real TOC field; Word recomputes page numbers on open).
 * Entries come from the current document's heading blocks; the command fails when there are no headings.
 */
export interface InsertToc {
  /** Insert after this block index; -1 = document start */
  afterBlockIndex: number
}

export type Command =
  | { updateTextStyle: UpdateTextStyle }
  | { updateMatchedTextStyle: UpdateMatchedTextStyle }
  | { updateParagraphStyle: UpdateParagraphStyle }
  | { setHeadingLevel: SetHeadingLevel }
  | { replaceAllText: ReplaceAllText }
  | { deleteBlocks: DeleteBlocks }
  | { moveBlocks: MoveBlocks }
  | { createParagraphBullets: CreateParagraphBullets }
  | { deleteParagraphBullets: DeleteParagraphBullets }
  | { updateImageProperties: UpdateImageProperties }
  | { insertToc: InsertToc }

/** numbering context so converted list items join real docx numbering on save */
export interface CommandContext {
  numIds?: { bullet: string | null; ordered: string | null } | null
  /** record the envelope's changes as tracked revisions under this author */
  track?: { author: string } | null
  /**
   * Selection frozen (in block-index space) when the model last saw the doc.
   * scope:'selection' resolves against this instead of the live selection, so
   * the user clicking elsewhere mid-run cannot retarget the command.
   */
  selection?: { startIndex: number; endIndex: number } | null
}

export interface CommandEnvelope {
  commands: Command[]
}

export interface CommandResult {
  command: string
  matched: number
  changed: number
  skippedProtected: number
  /** targets skipped because the text is a pending tracked deletion */
  skippedDeleted?: number
  detail?: string
}

export interface ExecuteOutcome {
  ok: boolean
  results: CommandResult[]
  summary: string
  error?: string
}

// ---- envelope extraction ----

/** pull a command envelope out of a model response; null = not command mode */
export function parseCommandEnvelope(raw: string): CommandEnvelope | null {
  const text = raw.trim()
  const fence = /```json\s*([\s\S]*?)```/.exec(text)
  const candidate = fence ? fence[1].trim() : text.startsWith('{') ? text : null
  if (!candidate) return null
  try {
    const parsed: unknown = JSON.parse(candidate)
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as CommandEnvelope).commands)
    ) {
      return parsed as CommandEnvelope
    }
  } catch {
    // not JSON: content mode
  }
  return null
}

// ---- validation (whole-envelope: any invalid command rejects everything) ----

const NODE_TYPES = ['docHeading', 'docParagraph', 'docListItem', 'image'] as const
const TEXT_STYLE_KEYS = [
  'color',
  'highlight',
  'sizeHalfPoints',
  'font',
  'bold',
  'italic',
  'underline',
  'strike',
  'baselineOffset',
  'link',
] as const
const PARA_STYLE_KEYS = [
  'align',
  'lineSpacing',
  'indentLeft',
  'indentRight',
  'indentFirstLine',
  'spaceBefore',
  'spaceAfter',
  'pageBreakBefore',
  'shadingFill',
  'borders',
] as const
const BASELINE_OFFSETS = ['SUPERSCRIPT', 'SUBSCRIPT', 'NONE'] as const
const COMMAND_NAMES = [
  'updateTextStyle',
  'updateMatchedTextStyle',
  'updateParagraphStyle',
  'setHeadingLevel',
  'replaceAllText',
  'deleteBlocks',
  'moveBlocks',
  'createParagraphBullets',
  'deleteParagraphBullets',
  'updateImageProperties',
  'insertToc',
] as const
const IMAGE_PROP_KEYS = ['widthPx', 'heightPx', 'align'] as const

type CommandName = (typeof COMMAND_NAMES)[number]

function validateTarget(target: unknown, where: string): string | null {
  if (!target || typeof target !== 'object') return `${where}: missing target`
  const t = target as Target
  if (t.nodeType !== undefined && !NODE_TYPES.includes(t.nodeType)) {
    return `${where}: unknown nodeType "${String(t.nodeType)}"`
  }
  if (
    t.headingLevel !== undefined &&
    (!Number.isInteger(t.headingLevel) || t.headingLevel < 1 || t.headingLevel > 6)
  ) {
    return `${where}: headingLevel must be an integer between 1 and 6`
  }
  if (
    t.blockIndexes !== undefined &&
    (!Array.isArray(t.blockIndexes) || t.blockIndexes.some((i) => !Number.isInteger(i) || i < 0))
  ) {
    return `${where}: blockIndexes must be an array of non-negative integers`
  }
  const hasCondition =
    t.nodeType !== undefined ||
    t.headingLevel !== undefined ||
    typeof t.containsText === 'string' ||
    (Array.isArray(t.blockIndexes) && t.blockIndexes.length > 0) ||
    t.scope === 'selection'
  if (!hasCondition) return `${where}: target requires at least one condition`
  return null
}

function validateStyleCommand(
  payload: { target?: unknown; style?: unknown; fields?: unknown },
  allowedKeys: readonly string[],
  where: string,
): string | null {
  const targetError = validateTarget(payload.target, where)
  if (targetError) return targetError
  if (!payload.style || typeof payload.style !== 'object') return `${where}: missing style`
  if (!Array.isArray(payload.fields) || payload.fields.length === 0) {
    return `${where}: fields must not be empty`
  }
  const bad = payload.fields.filter((f) => !allowedKeys.includes(String(f)))
  if (bad.length > 0) return `${where}: unknown fields ${bad.map(String).join(', ')}`
  return null
}

/** value checks shared by every command speaking the updateTextStyle style vocabulary */
function validateTextStyleValues(style: UpdateTextStyle['style'], where: string): string | null {
  if (
    style.baselineOffset != null &&
    !(BASELINE_OFFSETS as readonly string[]).includes(style.baselineOffset)
  ) {
    return `${where}: baselineOffset must be SUPERSCRIPT/SUBSCRIPT/NONE`
  }
  if (style.link != null && typeof style.link.url !== 'string') {
    return `${where}: link must be { url } or null`
  }
  return null
}

export function validateEnvelope(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return 'the envelope must be an object'
  const commands = (envelope as CommandEnvelope).commands
  if (!Array.isArray(commands) || commands.length === 0) return 'commands must be a non-empty array'
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i] as Record<string, unknown>
    if (!command || typeof command !== 'object') return `command #${i}: must be an object`
    const keys = Object.keys(command)
    if (keys.length !== 1) return `command #${i}: must be a single-key object`
    const name = keys[0]
    const where = `command #${i} ${name}`
    if (!COMMAND_NAMES.includes(name as CommandName)) return `${where}: unknown command`
    const payload = command[name] as Record<string, unknown>
    if (!payload || typeof payload !== 'object') return `${where}: parameters must be an object`
    let error: string | null = null
    switch (name as CommandName) {
      case 'updateTextStyle': {
        error = validateStyleCommand(payload, TEXT_STYLE_KEYS, where)
        if (!error)
          error = validateTextStyleValues(payload.style as UpdateTextStyle['style'], where)
        break
      }
      case 'updateParagraphStyle':
        error = validateStyleCommand(payload, PARA_STYLE_KEYS, where)
        break
      case 'setHeadingLevel': {
        error = validateTarget(payload.target, where)
        const level = payload.level
        if (!error && (!Number.isInteger(level) || Number(level) < 0 || Number(level) > 6)) {
          error = `${where}: level must be an integer between 0 and 6`
        }
        break
      }
      case 'replaceAllText':
        if (typeof payload.containsText !== 'string' || payload.containsText === '') {
          error = `${where}: containsText must not be empty`
        } else if (typeof payload.replaceText !== 'string') {
          error = `${where}: replaceText must be a string`
        } else if (payload.target !== undefined) {
          error = validateTarget(payload.target, where)
        }
        break
      case 'updateMatchedTextStyle': {
        if (typeof payload.containsText !== 'string' || payload.containsText === '') {
          error = `${where}: containsText must not be empty`
          break
        }
        if (payload.target !== undefined) {
          error = validateTarget(payload.target, where)
          if (error) break
        }
        if (!payload.style || typeof payload.style !== 'object') {
          error = `${where}: missing style`
        } else if (!Array.isArray(payload.fields) || payload.fields.length === 0) {
          error = `${where}: fields must not be empty`
        } else {
          const bad = payload.fields.filter(
            (f) => !(TEXT_STYLE_KEYS as readonly string[]).includes(String(f)),
          )
          if (bad.length > 0) error = `${where}: unknown fields ${bad.map(String).join(', ')}`
          else error = validateTextStyleValues(payload.style as UpdateTextStyle['style'], where)
        }
        break
      }
      case 'deleteBlocks':
        error = validateTarget(payload.target, where)
        break
      case 'moveBlocks':
        if (
          !Array.isArray(payload.blockIndexes) ||
          payload.blockIndexes.length === 0 ||
          payload.blockIndexes.some((i) => !Number.isInteger(i) || Number(i) < 0)
        ) {
          error = `${where}: blockIndexes must be a non-empty array of non-negative integers`
        } else if (
          !Number.isInteger(payload.afterBlockIndex) ||
          Number(payload.afterBlockIndex) < -1
        ) {
          error = `${where}: afterBlockIndex must be an integer ≥ -1`
        }
        break
      case 'createParagraphBullets': {
        error = validateTarget(payload.target, where)
        const preset = payload.bulletPreset
        if (
          !error &&
          preset !== undefined &&
          (typeof preset !== 'string' || !/^(BULLET|NUMBERED)/.test(preset))
        ) {
          error = `${where}: bulletPreset must start with BULLET or NUMBERED`
        }
        break
      }
      case 'deleteParagraphBullets':
        error = validateTarget(payload.target, where)
        break
      case 'updateImageProperties': {
        error = validateTarget(payload.target, where)
        if (!error) {
          if (!payload.properties || typeof payload.properties !== 'object') {
            error = `${where}: missing properties`
          } else if (!Array.isArray(payload.fields) || payload.fields.length === 0) {
            error = `${where}: fields must not be empty`
          } else {
            const bad = payload.fields.filter(
              (f) => !(IMAGE_PROP_KEYS as readonly string[]).includes(String(f)),
            )
            if (bad.length > 0) error = `${where}: unknown fields ${bad.map(String).join(', ')}`
          }
        }
        break
      }
      case 'insertToc':
        if (!Number.isInteger(payload.afterBlockIndex) || Number(payload.afterBlockIndex) < -1) {
          error = `${where}: afterBlockIndex must be an integer ≥ -1`
        }
        break
    }
    if (error) return error
  }
  return null
}

/** Legacy Workspace envelopes are validated first, then translated to the official
 * canonical executor. The adapter never mutates ProseMirror state itself. */
function maskedStyle(style: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, style[field] ?? null]))
}
function fontPatch(command: UpdateTextStyle | UpdateMatchedTextStyle): Record<string, unknown> {
  const patch = maskedStyle(command.style, command.fields)
  if ('sizeHalfPoints' in patch) {
    patch.fontSize = patch.sizeHalfPoints === null ? null : Number(patch.sizeHalfPoints) / 2
    delete patch.sizeHalfPoints
  }
  if ('font' in patch) {
    patch.fontFamily = patch.font
    delete patch.font
  }
  if ('baselineOffset' in patch) {
    patch.baseline =
      typeof patch.baselineOffset === 'string' ? patch.baselineOffset.toLowerCase() : null
    delete patch.baselineOffset
  }
  for (const key of ['bold', 'italic', 'underline', 'strike']) {
    if (patch[key] === null) patch[key] = false
  }
  return patch
}
export function commandToOp(command: Command): Op {
  if ('updateTextStyle' in command) {
    const c = command.updateTextStyle
    return { op: 'setFont', target: c.target, ...fontPatch(c) }
  }
  if ('updateMatchedTextStyle' in command) {
    const c = command.updateMatchedTextStyle
    return {
      op: 'setMatchedFont',
      target: c.target,
      text: c.containsText,
      matchCase: c.matchCase,
      ...fontPatch(c),
    }
  }
  if ('updateParagraphStyle' in command) {
    const c = command.updateParagraphStyle
    const patch = maskedStyle(c.style, c.fields)
    if (patch.pageBreakBefore === null) patch.pageBreakBefore = false
    return { op: 'setParagraphFormat', target: c.target, ...patch }
  }
  if ('replaceAllText' in command) {
    const c = command.replaceAllText
    return {
      op: 'findReplace',
      target: c.target,
      find: c.containsText,
      replace: c.replaceText,
      matchCase: c.matchCase,
    }
  }
  if ('createParagraphBullets' in command) {
    const c = command.createParagraphBullets
    return {
      op: 'setList',
      target: c.target,
      kind: c.bulletPreset?.startsWith('NUMBERED') ? 'number' : 'bullet',
    }
  }
  if ('deleteParagraphBullets' in command)
    return { op: 'clearList', ...command.deleteParagraphBullets }
  if ('updateImageProperties' in command) {
    const c = command.updateImageProperties
    return { op: 'setImageProperties', target: c.target, ...maskedStyle(c.properties, c.fields) }
  }
  const [op, payload] = Object.entries(command)[0]
  return { op, ...payload }
}
export function executeCommands(
  editor: Editor,
  envelope: CommandEnvelope,
  ctx: CommandContext = {},
): ExecuteOutcome {
  const error = validateEnvelope(envelope)
  if (error) return { ok: false, results: [], summary: '', error }
  const outcome = executeOps(editor, envelope.commands.map(commandToOp), ctx)
  return {
    ...outcome,
    results: outcome.results.map(({ op: _op, ...result }, i) => ({
      command: Object.keys(envelope.commands[i])[0],
      ...result,
    })),
  }
}
