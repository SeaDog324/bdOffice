/** Stable Host errors shown without leaking internal exception details. */
export const hostErrorCopy = {
  PAIRING_USED: '这个配对码已使用，请在电脑生成新的配对码。',
  PAIRING_RATE_LIMIT: '配对尝试过于频繁，请稍后再试。',
  PAIRING_REFUSED: '配对码不正确，请核对电脑显示的内容。',
  SESSION_INACTIVE: '这段会话已归档或移入回收站，请在电脑恢复后继续。',
  SESSION_NOT_FOUND: '这段会话已不存在，请返回会话列表刷新。',
  SESSION_LIMIT: '本次开发连接请求已达上限，请重启电脑端开发服务后重新配对。',
  EDITOR_REQUIRED:
    '手机上的文件对话目前只读，请在电脑的文件编辑器内继续；也可返回列表新建 AI 大狗对话处理文件。',
  REQUEST_CONFLICT: '这条请求的内容已变化，请返回会话后重新发送。',
}
