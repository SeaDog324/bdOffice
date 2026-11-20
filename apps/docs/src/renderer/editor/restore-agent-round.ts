import type { Editor } from '@tiptap/react'
import type { PmNode } from './convert'
import { TABLE_TRAILING_SKIP } from './extensions'

/** Restore the base of a round only while the editor still has its recorded head. */
export function restoreAgentRound(
  editor: Editor,
  base: PmNode,
  head?: Editor['state']['doc'],
): boolean {
  if (!editor.isEditable || (head && !editor.state.doc.eq(head))) return false
  const tracking = editor.storage.trackChanges
  const enabled = tracking?.enabled
  if (tracking) tracking.enabled = false
  try {
    return editor
      .chain()
      .setMeta(TABLE_TRAILING_SKIP, true)
      .setContent(base as never)
      .run()
  } finally {
    if (tracking && enabled !== undefined) tracking.enabled = enabled
  }
}
