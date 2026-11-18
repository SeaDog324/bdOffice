import { composeSkills, type AgentSkill } from './skill'

export interface EditorSaveBridge {
  save(): Promise<{ ok: boolean; path?: string }>
  taskDirty?(): boolean | undefined | Promise<boolean | undefined>
}
/** Uses the same editor writer as manual Save; model input cannot select a path or bypass conflicts. */
export function createEditorSaveSkill(
  getBridge = () =>
    (globalThis as { __genofficeWorkspaceAgent?: EditorSaveBridge }).__genofficeWorkspaceAgent,
): AgentSkill {
  return {
    id: 'editor-save',
    systemPrompt:
      'Editing and reading back do not save a file. When the user asks to save, call save_document after the edits and wait for its receipt before reporting completion. A failed/cancelled save or remaining dirty edits must be reported. Do not claim disk-content verification from a writer receipt alone.',
    tools: [
      {
        name: 'save_document',
        description:
          'Save the current document through the editor writer and wait for its result. No arbitrary output path. Returns a writer receipt, or an error if saving fails, is cancelled or leaves unsaved changes.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    async executeTool(call, signal) {
      if (call.name !== 'save_document')
        return { output: 'Unknown tool.', summary: call.name, isError: true }
      if (signal?.aborted)
        return {
          output: 'Save cancelled before execution.',
          summary: 'Save cancelled',
          isError: true,
        }
      const bridge = getBridge()
      if (!bridge?.save)
        return {
          output: 'The current editor does not support saving through this connection.',
          summary: 'Save unavailable',
          isError: true,
        }
      try {
        const receipt = await bridge.save()
        const dirty = await bridge.taskDirty?.()
        if (receipt?.ok !== true || dirty === true)
          return {
            output: JSON.stringify({
              saved: false,
              dirty: dirty ?? null,
              reason: receipt?.ok
                ? 'New or pending edits remain; inspect before retrying.'
                : 'The writer did not confirm saving. The file may require user input or conflict resolution.',
            }),
            summary: 'Save not confirmed',
            isError: true,
          }
        return {
          output: JSON.stringify({
            saved: true,
            basis: 'writer_receipt',
            ...(receipt.path ? { path: receipt.path } : {}),
          }),
          summary: 'Document saved',
        }
      } catch {
        return {
          output:
            'The document could not be saved. Check the editor status and resolve any conflict before retrying.',
          summary: 'Save failed',
          isError: true,
        }
      }
    },
  }
}
export const withEditorSaveSkill = (
  skill: AgentSkill,
  getBridge?: () => EditorSaveBridge | undefined,
) => composeSkills(skill.id, '', [skill, createEditorSaveSkill(getBridge)])
