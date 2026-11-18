type JsonSchema = Record<string, unknown>
const owns = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key)

function matchesSchemaType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

/** Shared JSON-Schema subset used by Workspace Registry and embedded editors.
 * Domain validators still enforce target freshness, command semantics and paths. */
export function validateToolInput(
  schema: JsonSchema,
  value: unknown,
  path = 'input',
): string | null {
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const variants = schema[keyword]
    if (Array.isArray(variants)) {
      const matches = variants.filter(
        (variant) => validateToolInput(variant as JsonSchema, value, path) === null,
      ).length
      if (matches === 0 || (keyword === 'oneOf' && matches !== 1))
        return `${path} must match ${keyword === 'oneOf' ? 'exactly one' : 'at least one'} allowed parameter variant.`
    }
  }
  const rawTypes = Array.isArray(schema.type) ? schema.type : [schema.type]
  const types = rawTypes.filter((item): item is string => typeof item === 'string')
  if (types.length && !types.some((type) => matchesSchemaType(value, type))) {
    return `${path} must be ${types.join(' or ')}.`
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    return `${path} must be one of ${schema.enum.map(String).join(', ')}.`
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      return `${path} must be at least ${schema.minimum}.`
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      return `${path} must be at most ${schema.maximum}.`
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))
      return `${path} does not match the required pattern ${schema.pattern}.`
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      return `${path} is shorter than ${schema.minLength} characters.`
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      return `${path} is longer than ${schema.maxLength} characters.`
  }
  if (Array.isArray(value)) {
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      return `${path} must contain unique items.`
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      return `${path} must contain at least ${schema.minItems} item(s).`
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      return `${path} must contain at most ${schema.maxItems} item(s).`
    if (schema.items && typeof schema.items === 'object') {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateToolInput(
          schema.items as JsonSchema,
          value[index],
          `${path}[${index}]`,
        )
        if (error) return error
      }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (
      typeof schema.minProperties === 'number' &&
      Object.keys(object).length < schema.minProperties
    )
      return `${path} must set at least one property.`
    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? (schema.properties as Record<string, unknown>)
        : {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !owns(object, key)) return `${path}.${key} is required.`
      }
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(object).find((key) => !owns(properties, key))
      if (extra) return `${path}.${extra} is not allowed.`
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!owns(object, key) || !childSchema || typeof childSchema !== 'object') continue
      const error = validateToolInput(childSchema as JsonSchema, object[key], `${path}.${key}`)
      if (error) return error
    }
  }
  return null
}
