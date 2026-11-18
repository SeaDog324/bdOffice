import type { DocumentContextService, DocumentContextSource } from './service'

/** Only the latest capture may publish an error or navigate to a conversation. */
export async function captureAndNavigate(
  contexts: DocumentContextService,
  source: () => DocumentContextSource | null,
  navigate: () => void,
): Promise<void> {
  const request = contexts.beginCapture()
  try {
    await contexts.capture(source(), request)
  } catch (error) {
    contexts.captureFailed(error, request)
  }
  if (contexts.isCurrentCapture(request)) navigate()
}
