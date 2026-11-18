/// <reference types="vite/client" />

import type { ConversationApi } from '@genoffice/project-store'
import type { HtmlApi } from '../shared/ipc'

declare global {
  interface Window {
    htmlApi: HtmlApi
    projectApi?: ConversationApi
  }
}

export {}
