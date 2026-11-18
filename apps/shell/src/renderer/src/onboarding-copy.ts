import type { ConnectionSetupError } from '../../shared/connection-setup-api'

const EN = {
  title: 'Meet AI BigDog',
  subtitle: 'Tell BigDog what you want to get done.',
  examples: [
    ['Edit a document', '“Change the payment term in this contract to 15 days.”'],
    ['Ask about your files', '“Summarize this report and list the decisions I need to make.”'],
    ['Create a deliverable', '“Create a project budget spreadsheet from these notes.”'],
  ],
  workflowTitle: 'Follow the work and check the result',
  workflow: [
    'Open a file or start a conversation, then describe your goal.',
    'Watch progress. If BigDog needs a decision, answer in the conversation.',
    'Review the changed files and save status. You can stop a running task.',
  ],
  connectTitle: 'Connect AI BigDog',
  connectSubtitle: 'Use an existing connection or add an API key. You can also do this later.',
  provider: 'Provider',
  key: 'API key',
  model: 'Model',
  endpoint: 'API address',
  advanced: 'Model and address (optional)',
  platform: 'Get a DeepSeek API key',
  apiDocs: 'API documentation',
  test: 'Test connection',
  testing: 'Testing…',
  tested: 'Connection verified. Save to start using BigDog.',
  save: 'Save and start',
  saving: 'Saving…',
  useExisting: 'Use current connection',
  existing: 'Your current connection is available. You can continue without changing it.',
  configured:
    'An API connection is already configured. Continue with it or connect another provider.',
  account: 'An account connection is selected. Manage accounts or switch to API in model settings.',
  change: 'Connect another API',
  settings: 'Open model settings',
  note: 'Testing sends a short request to this provider and may use its quota. Your key is saved only after a successful test.',
  privacy: 'You can skip AI setup and keep reading and editing documents.',
  loading: 'Checking current connection…',
  retry: 'Retry',
  cancelTest: 'Cancel test',
  inspectFailed: 'Could not read the connection. Retry or open model settings.',
  finishFailed: 'Could not save onboarding progress. Please try again.',
  reopen: 'How to use AI BigDog',
  reopenHint: 'Review the introduction or connect an API.',
  errors: {
    invalid_input: 'Check the API key, model and address.',
    settings_changed: 'Connection settings changed elsewhere. Reload and test again before saving.',
    account_selected: 'An account connection is selected. Switch to API in model settings first.',
    test_failed:
      'Connection failed. Check the key, model, provider access and network, then retry.',
    test_cancelled: 'The test was cancelled or timed out. You can retry.',
    verification_expired: 'The test result expired. Test again before saving.',
    save_failed: 'The connection was tested, but its settings could not be saved. Please retry.',
  } satisfies Record<ConnectionSetupError, string>,
}
type Copy = {
  [K in keyof typeof EN]: K extends 'examples'
    ? string[][]
    : K extends 'workflow'
      ? string[]
      : K extends 'errors'
        ? Record<ConnectionSetupError, string>
        : string
}
const ZH: Copy = {
  title: '认识 AI 大狗',
  subtitle: '直接告诉大狗，你想完成什么。',
  examples: [
    ['修改文档', '“把这份合同的付款期限改成 15 天。”'],
    ['根据资料问答', '“总结这份报告，列出需要我决定的事项。”'],
    ['生成成果文件', '“根据这些笔记，创建一份项目预算表。”'],
  ],
  workflowTitle: '看清进度，检查成果',
  workflow: [
    '打开文件或开始新对话，描述你要完成的目标。',
    '查看大狗的处理进度；需要你决定时，直接在对话中答复。',
    '检查修改过的文件和保存状态；执行中也可以停止任务。',
  ],
  connectTitle: '接通 AI 大狗',
  connectSubtitle: '沿用已有连接，或录入 API Key。也可以稍后再设置。',
  provider: '服务商',
  key: 'API Key',
  model: '模型',
  endpoint: 'API 地址',
  advanced: '模型和地址（可选）',
  platform: '前往 DeepSeek 获取 API Key',
  apiDocs: 'API 使用文档',
  test: '测试连接',
  testing: '正在测试…',
  tested: '连接测试成功，保存后就能向大狗提问。',
  save: '保存并开始',
  saving: '正在保存…',
  useExisting: '沿用当前连接',
  existing: '当前连接可用，可以直接继续。',
  configured: '已经配置了 API，可以沿用，也可以连接其他服务商。',
  account: '当前选择了账号连接。如需管理账号或改用 API，请打开模型设置。',
  change: '连接其他 API',
  settings: '打开模型设置',
  note: '测试会向所选服务商发送简短请求，可能消耗服务额度。测试成功后再由你保存密钥。',
  privacy: '可以跳过 AI 接入，继续阅读和编辑文档。',
  loading: '正在检查当前连接…',
  retry: '重试',
  cancelTest: '取消测试',
  inspectFailed: '暂时无法读取连接，请重试或打开模型设置。',
  finishFailed: '引导进度保存失败，请重试。',
  reopen: '大狗使用引导',
  reopenHint: '重新了解使用方式，或接入 API。',
  errors: {
    invalid_input: '请检查 API Key、模型和地址是否填写完整。',
    settings_changed: '连接设置已在其他位置变更，请重新加载并测试后再保存。',
    account_selected: '当前选择了账号连接，请先在模型设置中切换到 API。',
    test_failed: '连接失败，请检查密钥、模型、服务商权限及网络后重试。',
    test_cancelled: '测试已取消或超时，可以重新测试。',
    verification_expired: '测试结果已过期，请重新测试后再保存。',
    save_failed: '连接测试通过，但配置保存失败，请重试。',
  },
}
export function onboardingCopy(lang: string): Copy {
  return lang.startsWith('zh') ? ZH : EN
}
export const OPEN_ONBOARDING = 'bigdog:open-onboarding'
export function openOnboarding(connectionOnly = false): void {
  window.dispatchEvent(new CustomEvent(OPEN_ONBOARDING, { detail: { connectionOnly } }))
}
