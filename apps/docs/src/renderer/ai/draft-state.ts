const activeDrafts = new WeakSet<object>()
export const DRAFT_IO_ERROR =
  'Keep or discard the in-progress document draft before saving, exporting or using another editor agent.'
export const hasDocumentDraft = (editor: object | null | undefined): boolean =>
  !!editor && activeDrafts.has(editor)
export function setDocumentDraft(editor: object, active: boolean): void {
  if (active) activeDrafts.add(editor)
  else activeDrafts.delete(editor)
}
export function assertNoDocumentDraft(editor: object | null | undefined): void {
  if (hasDocumentDraft(editor)) throw new Error(DRAFT_IO_ERROR)
}
