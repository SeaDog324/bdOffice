export interface WordRoundChange {
  before?: string
  after?: string
  location?: string
}

/** Observed before/after results shown in the Word comparison pane. */
export interface WordRoundReview {
  runId: string
  completedAt: string
  state: 'completed' | 'undone' | 'undo-failed'
  baseVersion?: string
  resultVersion?: string
  changes: WordRoundChange[]
  fileChangeCount?: number
  incomplete: boolean
}
