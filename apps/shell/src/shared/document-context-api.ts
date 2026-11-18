import type { WorkspaceEditorContext, WorkspaceFileType } from './workspace-agent-api'

/** A host-owned reference to a specific editor document; never a renderer-supplied path grant. */
export interface DocumentContextView {
  id: string
  fileId: string
  path: string
  filePath?: string
  name: string
  type: WorkspaceFileType
  instanceId: number
  contentDigest: string
  capturedAt: number
  dirty: boolean
  memoryOnly: boolean
  editor?: WorkspaceEditorContext
}
