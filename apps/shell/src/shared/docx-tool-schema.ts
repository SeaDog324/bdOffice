import { HEX_COLOR_SCHEMA } from './workbook-tool-schema'

export const DOCX_STYLE_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    fontColor: {
      ...HEX_COLOR_SCHEMA,
      description: 'Font/text color only; never paragraph background or highlight.',
    },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: { type: 'boolean' },
    fontSizePt: { type: 'number', minimum: 1, maximum: 400 },
  },
}

/** Convert the public point/#RRGGBB contract to the official Docs run attributes. */
export function docxRunStyle(command: Record<string, unknown>) {
  const style = (command.style ?? {}) as Record<string, unknown>
  return {
    ...(typeof style.fontColor === 'string'
      ? { color: style.fontColor.slice(1).toUpperCase() }
      : {}),
    ...(typeof style.bold === 'boolean' ? { bold: style.bold } : {}),
    ...(typeof style.italic === 'boolean' ? { italic: style.italic } : {}),
    ...(typeof style.underline === 'boolean' ? { underline: style.underline } : {}),
    ...(typeof style.fontSizePt === 'number' ? { sizeHalfPoints: style.fontSizePt * 2 } : {}),
  }
}
