import type { WorkspaceFileType } from './workspace-agent-api'

export type ChangeLocation =
  | { kind: 'block'; blockId: string; index: number }
  | { kind: 'cell'; sheet: string; sheetId: string; range: string }
  | { kind: 'sheet'; sheet: string; sheetId: string }
  | { kind: 'slide'; slide: number; slideId?: string; elementId?: string }
  | { kind: 'page'; page: number }
  | { kind: 'line'; line: number }
  | { kind: 'file' }
  | {
      kind: 'resource'
      category: 'styles' | 'chart' | 'image' | 'layout' | 'pdf' | 'package'
      name: string
      page?: number
      slide?: number
      sheet?: string
    }

export interface LocatedChange {
  id: string
  location: ChangeLocation
  kind: 'text' | 'format' | 'structure' | 'content'
  before?: string
  after?: string
  beforeDigest?: string
  afterDigest?: string
  truncated?: boolean
}

/** Recorded observations, never model-authored claims or executable recovery state. */
export interface FileChangeEvidence {
  version: 1
  id: string
  recordedAt: string
  type: WorkspaceFileType
  source: 'live_editor' | 'document' | 'filesystem'
  effect: 'changed' | 'unchanged' | 'unknown'
  beforeVersion?: string
  afterVersion?: string
  diskVersion?: string
  saveState: 'memory_only' | 'pending_save' | 'saved' | 'unknown'
  verification: 'passed' | 'failed' | 'unknown'
  basis: 'disk_readback' | 'live_snapshot' | 'file_hash' | 'unavailable'
  verificationScope?: 'editor_model' | 'package_bytes' | 'text_values' | 'file_bytes' | 'unknown'
  details: LocatedChange[]
  resources?: LocatedChange[]
  omitted: number
  incomplete: boolean
  issue?: 'observation_failed' | 'save_failed' | 'save_unverified' | 'tool_failed' | 'limited'
}
