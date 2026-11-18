import { useEffect, useRef } from 'react'
import type { AgentLoop } from '@genoffice/agent-core'
import type { ConversationApi, ResolveChatResult, ChatMessage } from '@genoffice/project-store'
import { restoreChatContext, type ChatIdentityRef } from '@genoffice/project-store/browser'

/** Switching conversation state never remounts the document editor. */
export function useManagedChatActivation<T>(options: {
  api: ConversationApi | undefined
  ids: ChatIdentityRef
  loop: { current: AgentLoop<T> | null }
  clear(): void
  cancel(): void
  history(rows: ChatMessage[]): void
  error?(message: string): void
}): void {
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    const api = latest.current.api
    if (!api?.onChatActivated) return
    let epoch = 0,
      alive = true
    const activate = async (ids: ResolveChatResult) => {
      const opts = latest.current
      if (opts.loop.current?.busy && opts.ids.current?.chatId === ids.chatId) return
      const seq = ++epoch
      opts.clear()
      opts.loop.current?.reset()
      opts.ids.current = ids
      try {
        const rows = await api.loadChat({ ...ids, limit: 200 })
        if (!alive || seq !== epoch || latest.current.ids.current?.chatId !== ids.chatId) return
        await restoreChatContext(api, ids, latest.current.loop.current, rows)
        if (alive && seq === epoch && latest.current.ids.current?.chatId === ids.chatId)
          latest.current.history(rows)
      } catch (error) {
        if (alive && seq === epoch) latest.current.error?.(String(error))
      }
    }
    const off = api.onChatActivated((ids) => {
      void activate(ids)
    })
    const stop = api.onChatCancelled?.((source) => {
      const opts = latest.current
      if (
        opts.ids.current?.projectId === source?.projectId &&
        opts.ids.current?.chatId === source?.chatId
      )
        opts.cancel()
    })
    void api.pendingChat?.(true).then((ids) => {
      if (alive && ids && epoch === 0) void activate(ids)
    })
    return () => {
      alive = false
      epoch++
      off()
      stop?.()
    }
  }, [])
}

export function useManagedChatOpen(api: ConversationApi | undefined, open: () => void): void {
  const latest = useRef(open)
  latest.current = open
  useEffect(() => {
    if (!api?.onChatActivated) return
    let alive = true
    const off = api.onChatActivated(() => latest.current())
    void api.pendingChat?.(false).then((ids) => {
      if (alive && ids) latest.current()
    })
    return () => {
      alive = false
      off()
    }
  }, [api])
}

export function managedChatRows(rows: ChatMessage[]) {
  return rows.map((row) => ({
    role: row.role,
    text: row.text,
    tools: (row.tools ?? []).map((t) => ({ ...t, isError: t.isError ?? false })),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.attachments
      ? {
          attachments: row.attachments.map((a) => ({
            name: a.name,
            path: a.path ?? '',
            ext: a.ext ?? '',
            sizeBytes: a.sizeBytes ?? 0,
          })),
        }
      : {}),
  }))
}
