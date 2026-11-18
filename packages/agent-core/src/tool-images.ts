import type { AgentImage, AgentMessage, AgentToolResult, ToolExecution } from './types'

const MAX_IMAGE_CHARS = Math.ceil((2 * 1024 * 1024 * 4) / 3)
export function boundedToolImages(images: AgentImage[] | undefined): AgentImage[] {
  if (!Array.isArray(images)) return []
  return images
    .slice(0, 1)
    .filter(
      (image) =>
        !!image &&
        /^image\/(png|jpeg|webp)$/.test(image.mime) &&
        typeof image.base64 === 'string' &&
        image.base64.length > 0 &&
        image.base64.length <= MAX_IMAGE_CHARS,
    )
    .map((image) => ({ mime: image.mime, base64: image.base64 }))
}
export function withoutToolImages<T extends AgentToolResult | ToolExecution>(value: T): T {
  if (!value.images) return value
  const { images: _images, ...rest } = value
  return rest as T
}
export function durableMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) =>
    message.role === 'tool'
      ? { ...message, results: message.results.map(withoutToolImages) }
      : message,
  )
}
/** Keep only the newest visual observation. Older screen coordinates must be re-observed. */
export function appendToolImages(
  history: AgentMessage[],
  execution: ToolExecution,
  partial?: AgentToolResult[],
): { images?: AgentImage[] } {
  const images = boundedToolImages(execution.images)
  if (images.length)
    for (const message of history)
      if (message.role === 'tool') {
        message.results = message.results.map(withoutToolImages)
      }
  if (images.length && partial) for (const result of partial) delete result.images
  return images.length ? { images } : {}
}
