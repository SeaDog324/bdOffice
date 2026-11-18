/// <reference types="vite/client" />

import type { ConversationApi } from '@genoffice/project-store'
import type { MarkdownApi } from '../shared/ipc'

declare global {
  interface Window {
    markdownApi: MarkdownApi
    projectApi?: ConversationApi
  }
}

export {}
