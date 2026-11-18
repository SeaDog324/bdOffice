/** Only Host task state updates a confirmed request's notice. Unknown state retains the receipt wording. */
export function noticeForAcceptedTask(task, fallback = '') {
  if (!task) return fallback
  const labels = {
    queued: '电脑已接收，正在排队。',
    preparing: '电脑正在准备处理。',
    running: '大狗正在处理这条请求。',
    verifying: '电脑正在核验结果。',
    waiting_device: '请求已接收，等待电脑准备就绪。',
    waiting_resource: '请求已接收，等待文件或资源准备。',
    waiting_user: '请核对并确认当前任务，随后继续。',
    pausing: '正在暂停。',
    paused: '任务已暂停。',
    cancelling: '正在停止。',
    cancelled: '这条请求已停止。',
    interrupted: '任务中断，请核对后继续。',
    failed: '任务未完成，请查看原因后重试。',
    completed: '本次处理已结束，请查看答复和成果，确认目标是否达成。',
  }
  const text = labels[task.state]
  return text ? (task.title ? `“${String(task.title).slice(0, 50)}”：${text}` : text) : fallback
}
