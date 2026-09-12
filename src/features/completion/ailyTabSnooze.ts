import { ailyTabSnoozeDeadline } from './ailyTabControls'

export const AILY_TAB_SNOOZE_KEY = 'aily.completion.snoozeUntil'

type SnoozeStore = { read(): unknown; write(until: number): void; flush?(): Promise<void> }

/** Retain an absolute deadline across reloads; resuming never replays old work. */
export class AilyTabSnooze {
  private deadline = 0
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly store: SnoozeStore, private readonly changed: () => void) {
    this.restore()
  }
  get until(): number { return this.deadline }
  restore(): void {
    const saved = this.store.read()
    const now = Date.now()
    this.deadline = typeof saved === 'number' && Number.isSafeInteger(saved) && saved > now && saved - now <= 8 * 60 * 60_000 ? saved : 0
    if (!this.deadline && saved !== undefined && saved !== 0) this.store.write(0)
    this.arm()
    this.changed()
  }
  async pause(durationMs: number): Promise<void> {
    this.deadline = ailyTabSnoozeDeadline(Date.now(), durationMs)
    this.store.write(this.deadline)
    this.arm()
    await this.store.flush?.()
    this.changed()
  }
  async resume(): Promise<void> {
    this.deadline = 0
    this.store.write(0)
    this.arm()
    await this.store.flush?.()
    this.changed()
  }
  dispose(): void { clearTimeout(this.timer) }
  private arm(): void {
    clearTimeout(this.timer)
    if (!this.deadline) return
    const remaining = this.deadline - Date.now()
    if (remaining <= 0) { void this.resume(); return }
    this.timer = setTimeout(() => {
      this.arm()
      this.changed()
    }, Math.min(remaining, remaining <= 60_000 ? 1000 : 60_000))
  }
}
