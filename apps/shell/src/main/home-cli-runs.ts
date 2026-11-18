/** Owner-scoped cancellation for Home's bundled CLI work. */
export class HomeCliRuns {
  private readonly runs = new Map<string, { owner: number; controller: AbortController }>()

  async run<T>(
    owner: number,
    id: string,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid CLI run identifier.')
    if (this.runs.has(id)) throw new Error('This CLI run is already active.')
    const controller = new AbortController()
    this.runs.set(id, { owner, controller })
    try {
      return await execute(controller.signal)
    } finally {
      this.runs.delete(id)
    }
  }

  cancel(owner: number, id: string): boolean {
    const run = this.runs.get(id)
    if (!run || run.owner !== owner) return false
    run.controller.abort()
    return true
  }

  cancelOwner(owner: number): void {
    for (const run of this.runs.values()) if (run.owner === owner) run.controller.abort()
  }
}
