/** User-facing account wording; protocol details stay out of the interface. */
export function accountCopy(lang: string) {
  return /^zh(?:-|$)/u.test(lang)
    ? {
        title: '连接账户',
        description: '用于 Agent 和文档助手，无需填写 API Key。',
        api: 'API 配置',
        apiDetail: '用于 Agent 和文档助手',
        selected: '正在使用',
        use: '使用',
        connect: '连接账户',
        update: '检查更新',
        logout: '退出登录',
        busy: '连接中…',
        boundary: '图像生成需单独配置。',
        claudeUnavailable: 'Claude 订阅登录需厂商授权，暂未开放。',
        error: '连接失败，请重试。',
        phase: {
          'not-installed': '未连接',
          installing: '正在准备…',
          preparing: '正在准备…',
          'signed-out': '未连接',
          authenticating: '请在浏览器中登录',
          ready: '已连接',
          error: '连接异常，请重新连接',
          blocked: '暂未开放',
        },
      }
    : {
        title: 'Connect an account',
        description: 'Use with the Agent and document assistants. No API key needed.',
        api: 'API configuration',
        apiDetail: 'For the Agent and document assistants',
        selected: 'In use',
        use: 'Use',
        connect: 'Connect account',
        update: 'Check for updates',
        logout: 'Sign out',
        busy: 'Connecting…',
        boundary: 'Image generation is configured separately.',
        claudeUnavailable:
          'Claude subscription sign-in requires vendor approval and is not yet available.',
        error: 'Connection failed. Please try again.',
        phase: {
          'not-installed': 'Not connected',
          installing: 'Preparing…',
          preparing: 'Preparing…',
          'signed-out': 'Not connected',
          authenticating: 'Sign in using your browser',
          ready: 'Connected',
          error: 'Connection issue. Please reconnect.',
          blocked: 'Not available yet',
        },
      }
}

export function accountErrorText(error: unknown, lang = 'en'): string {
  const detail = error instanceof Error ? error.message : String(error)
  const zh = /^zh(?:-|$)/u.test(lang)
  if (/prior approval|third.party|subscription rate limits/u.test(detail))
    return accountCopy(lang).claudeUnavailable
  if (/image input|image attachments|unsupported image/iu.test(detail))
    return zh
      ? '此账户连接暂不支持图片理解，请移除图片后重试。'
      : 'This account connection does not support image input yet. Remove the images and try again.'
  if (/timeout|timed out/iu.test(detail))
    return zh ? '请求超时，请重试。' : 'Request timed out. Please try again.'
  if (/busy|active requests|stopping|already generating/iu.test(detail))
    return zh
      ? '正在处理其他请求，请稍后再试。'
      : 'Another request is in progress. Please try again shortly.'
  if (/permission|sandbox/iu.test(detail))
    return zh
      ? '安全连接尚未就绪，请重新连接账户。'
      : 'Secure connection is not ready. Please reconnect your account.'
  if (/protocol|undeclared|schema/iu.test(detail))
    return zh
      ? '连接需要更新，请在账户设置中检查更新。'
      : 'This connection needs an update. Check for updates in account settings.'
  if (/not installed|not ready|not connected|connect a|sign.in|signed out|OAuth/iu.test(detail))
    return zh ? '请在设置中重新连接账户。' : 'Please reconnect your account in Settings.'
  if (/network|fetch|download|ECONN|ENOTFOUND/iu.test(detail))
    return zh
      ? '连接失败，请检查网络后重试。'
      : 'Could not connect. Check your network and try again.'
  if (/quota|rate.limit|credits|usage.limit/iu.test(detail))
    return zh
      ? '账户额度暂不可用，请检查订阅或稍后重试。'
      : 'Account usage is unavailable. Check your plan or try again later.'
  return accountCopy(lang).error
}
