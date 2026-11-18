import { randomUUID } from 'node:crypto'

/** Per-open-document capabilities, never predictable WebContents IDs or disk paths. */
export class PreviewAccess {
  private readonly tokens = new Map<number, string>()
  private readonly owners = new Map<string, number>()

  grant(owner: number): void {
    if (this.tokens.has(owner)) return
    const token = randomUUID()
    this.tokens.set(owner, token)
    this.owners.set(token, owner)
  }

  revoke(owner: number): void {
    const token = this.tokens.get(owner)
    if (token) this.owners.delete(token)
    this.tokens.delete(owner)
  }

  owner(token: string): number | undefined {
    return this.owners.get(token)
  }

  url(owner: number, scheme: 'html-preview' | 'html-asset'): string | null {
    const token = this.tokens.get(owner)
    return token ? `${scheme}://${token}/` : null
  }
}
