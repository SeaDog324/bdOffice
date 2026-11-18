// Mirrors the official Workbook DSL format patch. Contract tests parse every field
// against workbookOperationSchema so upstream drift fails the merge gate.
const nullableBoolean = { type: ['boolean', 'null'] }
export const HEX_COLOR_SCHEMA = { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }
export const CELL_VALUE_SCHEMA = { type: ['string', 'number', 'boolean', 'null'] }
export const CELL_VALUES_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'array',
    minItems: 1,
    items: CELL_VALUE_SCHEMA,
  },
}
export const CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'doughnut']
export const WORKBOOK_FORMAT_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    bold: nullableBoolean,
    italic: nullableBoolean,
    underline: nullableBoolean,
    strikethrough: nullableBoolean,
    wrapText: nullableBoolean,
    fontFamily: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
    fontSize: { type: ['number', 'null'], minimum: 1, maximum: 409 },
    fontColor: {
      ...HEX_COLOR_SCHEMA,
      type: ['string', 'null'],
      description: 'Text color, #RRGGBB. null clears the override.',
    },
    fillColor: {
      ...HEX_COLOR_SCHEMA,
      type: ['string', 'null'],
      description: 'Cell background color, #RRGGBB. This does not change text color.',
    },
    numberFormat: { type: ['string', 'null'], minLength: 1, maxLength: 255 },
    horizontalAlign: { enum: ['left', 'center', 'right', null] },
    verticalAlign: { enum: ['top', 'center', 'bottom', null] },
    textRotation: {
      anyOf: [{ type: 'integer', minimum: -90, maximum: 90 }, { enum: ['vertical', null] }],
    },
    indent: { type: ['integer', 'null'], minimum: 0, maximum: 250 },
    border: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { enum: ['all', 'top', 'bottom', 'left', 'right', 'none'] },
        color: HEX_COLOR_SCHEMA,
      },
    },
  },
}
