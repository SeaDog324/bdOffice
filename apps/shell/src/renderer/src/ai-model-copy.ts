/** AI settings use a Chinese / English fallback. */
export function aiModelCopy(lang: string) {
  return /^zh(?:-|$)/u.test(lang)
    ? {
        tabs: { api: '对话 API', accounts: '账号登录', images: '图像生成', search: '网络搜索' },
        tabsLabel: 'AI 配置方式',
        searchProvider: '搜索服务',
        searchDefault: '默认搜索',
        searchHint: '设置大狗的网页搜索来源，保存后生效。本机文件搜索不受影响。',
        searchKeyHint: '填写所选服务的 API Key；留空时使用默认搜索。',
        parallelKeyHint:
          '留空使用 Parallel 公开 MCP；填写 Key 使用你的 Parallel API。图片搜索使用原有来源。',
        chatHint: '用于大狗对话和文档助手。',
        imageHint: '所有编辑器共用，与对话模型独立配置。',
        imageProvider: '生图厂商',
        imageModel: '生图模型 ID',
        imageModelHint: '填写已开通的生图型号。',
        imageKey: '生图 API Key',
        imageKeyHint: '独立于对话 API；账号订阅不包含生图 API 额度。',
        imageBase: '生图 API 地址',
        imageBaseHint: '留空使用厂商默认地址；代理或地域地址必须支持所选生图协议。',
        customHint:
          '自定义服务必须支持 OpenAI Images API 的 /images/generations，不能只支持聊天接口；本地免密服务可留空 Key。',
        qwenHint:
          '使用百炼原生 /api/v1，不是聊天的 /compatible-mode/v1。北京、新加坡和业务空间域名必须与 Key 地域一致。本页接入 Qwen Image 同步生图，不含 Wan 异步任务。',
        protocol: '调用协议',
        checkImage: '检查格式',
        imageChecked: '配置格式有效；未验证密钥权限，也未发起付费生图。',
        imageCheckHint: '仅检查格式，不生成图片。实际生图按厂商 API 计费。',
        unsaved: '配置已修改，保存后生效。',
        loading: '正在读取 AI 配置…',
        saving: '正在保存…',
        loadFailed: '无法读取 AI 配置',
        saveFailed: '保存失败',
        modelHint: '从列表选择，或输入模型 ID。',
        chooseModel: '选择模型',
        fetchModels: '获取上游模型',
        refreshModels: '刷新模型列表',
        fetchingModels: '正在获取上游模型…',
        cancelModels: '取消获取',
        autoModels: '填写密钥和地址后自动获取列表，不发起对话。',
        presetModels: '内置参考列表；实际可用型号以上游返回为准。',
        upstreamModels: '上游模型',
        modelsSaved: '刷新列表不会切换模型。',
        modelNotListed: '当前型号未在上游列表中，已保留；可继续手动使用或选择其他型号。',
        responsesRequired:
          'GPT-6 Astra 在此 API 配置下暂不支持工具调用，请使用账号登录或其他模型。',
        modelErrors: {
          invalid_request: '模型查询请求无效。',
          missing_key: '请先填写该厂商的 API Key。',
          invalid_base_url: '请填写有效的 API 基础地址，不要在地址中包含密码、查询参数或片段。',
          unsupported_provider: '该服务商暂不支持模型发现。',
          unauthorized: '上游拒绝访问，请检查 API Key 和模型列表权限。',
          unsupported_endpoint: '上游未提供兼容的模型列表接口；仍可手动填写模型。',
          rate_limited: '上游请求过于频繁，请稍后手动刷新。',
          upstream_error: '上游模型查询失败，原列表保持不变。',
          invalid_response: '上游返回的不是受支持的模型目录，原列表保持不变。',
          empty_list: '上游没有返回可用的对话模型，原列表保持不变。',
          too_large: '上游目录超过安全大小或分页限制，原列表保持不变。',
          timeout: '获取模型超时，原列表保持不变。',
          cancelled: '已取消获取，原列表保持不变。',
          network: '无法获取模型，请检查网络和 API 地址；仍可使用已有列表或手动输入。',
        },
      }
    : {
        tabs: {
          api: 'Chat API',
          accounts: 'Account sign-in',
          images: 'Image generation',
          search: 'Web search',
        },
        tabsLabel: 'AI configuration pages',
        searchProvider: 'Search service',
        searchDefault: 'Default search',
        searchHint:
          'Choose a web search provider and save to apply. Local file search is unchanged.',
        searchKeyHint: 'Enter the provider API key, or leave blank to use default search.',
        parallelKeyHint:
          'Leave blank for the public Parallel MCP, or enter your Parallel API key. Image search uses the existing sources.',
        chatHint: 'For BigDog chat and document assistants.',
        imageHint: 'Shared by all editors, configured independently of chat.',
        imageProvider: 'Image provider',
        imageModel: 'Image-generation model ID',
        imageModelHint: 'Enter an enabled image-generation model.',
        imageKey: 'Image API key',
        imageKeyHint:
          'Saved independently of the chat API. Subscription sign-in does not grant access or credits for this API.',
        imageBase: 'Image API base URL',
        imageBaseHint:
          'Leave blank for the vendor default. Regional endpoints and proxies must support the selected image protocol.',
        customHint:
          'The service must implement OpenAI Images API /images/generations, not just chat. A key is optional for unauthenticated local servers.',
        qwenHint:
          'Use native Model Studio /api/v1, not chat /compatible-mode/v1. Match the key region to Beijing, Singapore or your workspace endpoint. Supports synchronous Qwen Image, not asynchronous Wan tasks.',
        protocol: 'Wire protocol',
        checkImage: 'Check format',
        imageChecked:
          'Valid configuration format; credentials are unverified and no billable image request was made.',
        imageCheckHint:
          'This check validates local configuration only. Actual image generation uses vendor API billing, separate from account subscriptions.',
        unsaved: 'Configuration changed. Save to apply.',
        loading: 'Loading AI configuration…',
        saving: 'Saving…',
        loadFailed: 'Could not load AI configuration',
        saveFailed: 'Save failed',
        modelHint: 'Choose from the list or enter a model ID.',
        chooseModel: 'Choose model',
        fetchModels: 'Get upstream models',
        refreshModels: 'Refresh models',
        fetchingModels: 'Fetching upstream models…',
        cancelModels: 'Cancel fetch',
        autoModels: 'Fetches after you finish editing the key and URL. No chat request is sent.',
        presetModels: 'Built-in suggestions; actual availability depends on the upstream catalog.',
        upstreamModels: 'Upstream models',
        modelsSaved: 'Refreshing the list does not switch models.',
        modelNotListed:
          'The selected model is not in the upstream list. It is retained for manual use.',
        responsesRequired:
          'GPT-6 Astra cannot use tools with this API configuration yet. Use account sign-in or another model.',
        modelErrors: {
          invalid_request: 'Invalid model discovery request.',
          missing_key: 'Enter the provider API key first.',
          invalid_base_url:
            'Enter a valid API base URL without credentials, query parameters or fragments.',
          unsupported_provider: 'Model discovery is unavailable for this provider.',
          unauthorized: 'Access denied. Check the API key and model-list permissions.',
          unsupported_endpoint:
            'The upstream does not expose a compatible model list. You can still enter a model ID.',
          rate_limited: 'Rate limited. Please refresh manually later.',
          upstream_error: 'Upstream query failed; the previous list is retained.',
          invalid_response: 'Unsupported model catalog response; the previous list is retained.',
          empty_list: 'No chat models returned; the previous list is retained.',
          too_large:
            'The catalog exceeds the size or pagination limit; the previous list is retained.',
          timeout: 'Model discovery timed out; the previous list is retained.',
          cancelled: 'Fetch cancelled; the previous list is retained.',
          network:
            'Could not fetch models. Check the network and API URL, or use the existing list or a manual ID.',
        },
      }
}
