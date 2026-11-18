import type { IpcMainInvokeEvent, WebContents } from 'electron'

/** Network/integration settings belong to the Shell main frame, never document frames. */
export function assertTrustedSettingsSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  contents: WebContents | undefined,
): void {
  if (
    !contents ||
    contents.isDestroyed() ||
    event.sender !== contents ||
    event.senderFrame !== contents.mainFrame
  )
    throw new Error('This operation requires the trusted settings window.')
}
