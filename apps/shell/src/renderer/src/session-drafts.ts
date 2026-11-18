/** A draft belongs to one conversation, including before the first Session exists. */
export class SessionDrafts {
  private readonly drafts = new Map<string, string>()
  constructor(
    private readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
      Partial<Pick<Storage, 'key' | 'length'>>,
  ) {}
  read(id: string | null): string {
    const key = id ?? 'pending'
    if (!this.drafts.has(key)) {
      let text = ''
      try {
        text = this.storage?.getItem('bigdog:chat-draft:' + key) ?? ''
      } catch {}
      this.drafts.set(key, text)
    }
    return this.drafts.get(key)!
  }
  write(id: string | null, text: string): void {
    const key = id ?? 'pending'
    this.drafts.set(key, text)
    try {
      if (text) this.storage?.setItem('bigdog:chat-draft:' + key, text)
      else this.storage?.removeItem('bigdog:chat-draft:' + key)
    } catch {
      /* Keep the in-memory draft if storage is full or unavailable. */
    }
  }
  adoptPending(id: string): void {
    const pending = this.read(null)
    if (pending && !this.read(id)) {
      this.write(id, pending)
      this.write(null, '')
    }
  }
  restoreSelection(current: string | null, sessionIds: string[]): string | null {
    if (current && sessionIds.includes(current)) return current
    // The unbound composer is its own conversation. A recent empty Session
    // must not become its owner merely because the app restarted.
    return this.read(null) ? null : (sessionIds[0] ?? null)
  }
  clearSent(id: string | null, sent: string): void {
    // A slow IPC completion must not erase text typed after Send.
    if (this.read(id) === sent) this.write(id, '')
  }
  retain(sessionIds: string[]): void {
    const keep = new Set(['pending', ...sessionIds])
    const known = new Set(this.drafts.keys())
    try {
      for (let i = 0; i < (this.storage?.length ?? 0); i++) {
        const key = this.storage?.key?.(i)
        if (key?.startsWith('bigdog:chat-draft:')) known.add(key.slice('bigdog:chat-draft:'.length))
      }
    } catch {}
    for (const id of known)
      if (!keep.has(id)) {
        this.write(id, '')
        this.drafts.delete(id)
      }
  }
}
