/** New settings feedback follows the shell's Chinese / English fallback. */
export function settingsCopy(lang: string) {
  return /^zh(?:-|$)/u.test(lang)
    ? {
        loading: '正在读取…',
        retry: '重试',
        loadFailed: '读取失败，请重试。',
        saving: '正在保存…',
        saved: '已保存',
        saveFailed: '保存失败，请重试。',
        working: '正在处理…',
        copyFailed: '复制失败，请选中文字手动复制。',
        copied: '已复制',
        reopen: '重新查看',
        integrationSummary:
          '让外部 AI 助手创建、转换和编辑办公文件。文件处理在本机完成；助手及搜索、生图服务可能向其服务商发送相关内容。',
        advancedMcp: '高级：MCP 连接',
        sharedAgents: 'Codex、Cursor 等助手',
        sharedAgentsHint: '共用一份技能，无需逐个安装。',
      }
    : {
        loading: 'Loading…',
        retry: 'Retry',
        loadFailed: 'Could not load. Please retry.',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Could not save. Please retry.',
        working: 'Working…',
        copyFailed: 'Copy failed. Select the text to copy manually.',
        copied: 'Copied',
        reopen: 'View again',
        integrationSummary:
          'Let external AI assistants create, convert and edit Office files. File processing is local; assistants, search and image services may send relevant content to their providers.',
        advancedMcp: 'Advanced: MCP connections',
        sharedAgents: 'Codex, Cursor and compatible assistants',
        sharedAgentsHint: 'One shared skill installation for compatible assistants.',
      }
}
