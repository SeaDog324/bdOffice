import type { BigDogReleaseStatus } from '../shared/bigdog-release'
import type { UpdateChannel } from '../shared/update-api'

/** One process-wide checker. Channel switches invalidate stale responses; no
 * repeated prompt for a dismissed version until the next application session. */
export class ReleaseMonitor {
  private channel: UpdateChannel
  private generation = 0
  private value: BigDogReleaseStatus | null = null
  private dismissed = new Set<string>()
  private pending: Promise<BigDogReleaseStatus> | null = null
  private checkedAt = -Infinity
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(
    channel: UpdateChannel,
    private readonly request: (channel: UpdateChannel) => Promise<BigDogReleaseStatus>,
    private readonly changed: (value: BigDogReleaseStatus | null) => void,
  ) {
    this.channel = channel
  }

  snapshot(): BigDogReleaseStatus | null {
    return this.value?.phase === 'available' && this.dismissed.has(this.value.version)
      ? null
      : this.value
  }

  check(): Promise<BigDogReleaseStatus> {
    if (this.pending) return this.pending
    // Bound manual-click traffic as well as background requests; never expose tokens.
    if (this.value && Date.now() - this.checkedAt < 60_000) return Promise.resolve(this.value)
    const generation = this.generation
    const pending = this.request(this.channel)
      .catch((): BigDogReleaseStatus => ({ phase: 'error' }))
      .then((value) => {
        if (generation === this.generation) {
          this.value = value
          this.checkedAt = Date.now()
          this.changed(this.snapshot())
        }
        return value
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null
      })
    this.pending = pending
    return pending
  }

  setChannel(channel: UpdateChannel): void {
    if (channel === this.channel) return
    this.channel = channel
    this.generation++
    this.pending = null
    this.value = null
    this.checkedAt = -Infinity
    this.changed(null)
    void this.check()
  }

  dismiss(version: unknown): void {
    if (this.value?.phase !== 'available' || version !== this.value.version) return
    this.dismissed.add(this.value.version)
    this.changed(null)
  }

  start(): void {
    if (this.timers.length) return
    this.timers = [
      setTimeout(() => void this.check(), 20_000),
      setInterval(() => void this.check(), 6 * 60 * 60_000),
    ]
    for (const timer of this.timers) timer.unref?.()
  }

  stop(): void {
    this.generation++
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }
}
