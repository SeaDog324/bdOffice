/** Mode selection is confirmed before the shared policy can release pending actions. */
export function confirmApprovalMode(mode: 'auto' | 'per-action', zh: boolean): boolean {
  const message = zh
    ? mode === 'auto'
      ? '切换为自动执行？\n\n这会对所有对话和文件助手生效，并放行当前等待审批的操作。后续修改、保存和命令会自动执行，部分操作无法撤销。'
      : '切换为每次审批？\n\n后续需要批准的操作会等待你确认。正在执行的操作不会被中止。'
    : mode === 'auto'
      ? 'Switch to auto execute?\n\nThis applies to all conversations and file assistants and releases pending approvals. Subsequent edits, saves and commands will run automatically; some actions cannot be undone.'
      : 'Switch to per-action approval?\n\nSubsequent protected actions will wait for your confirmation. Actions already running will not be stopped.'
  return window.confirm(message)
}
