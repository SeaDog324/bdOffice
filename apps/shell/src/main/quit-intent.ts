/** Keep an explicit Quit distinct from closing the last macOS window. */
export class QuitIntent {
  private requested = false

  constructor(private readonly platform: NodeJS.Platform) {}

  request(): void {
    this.requested = true
  }

  cancel(): void {
    this.requested = false
  }

  shouldQuitWhenAllWindowsClosed(): boolean {
    return this.platform !== 'darwin' || this.requested
  }
}
