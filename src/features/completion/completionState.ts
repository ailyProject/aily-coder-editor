import type { RecentEdit } from './suggestionProtocol'

export const abortError = (): DOMException => new DOMException('Suggestion cancelled', 'AbortError')
/** One remote inference at a time. Higher priority input cancels background predictions. */
export class CompletionCoordinator {
  private active?: { priority: number; controller: AbortController }
  private pending?: { priority: number; start: () => void; cancel: () => void }
  run<T>(priority: number, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      let started = false
      const cancel = () => { controller.abort(); if (!started) { signal?.removeEventListener('abort', cancel); reject(abortError()) } }
      const entry = { priority, cancel, start: () => {
        if (controller.signal.aborted || signal?.aborted) { reject(abortError()); this.drain(); return }
        started = true; this.active = { priority, controller }
        void operation(controller.signal).then(resolve, reject).finally(() => {
          signal?.removeEventListener('abort', cancel)
          if (this.active?.controller === controller) this.active = undefined
          this.drain()
        })
      } }
      signal?.addEventListener('abort', cancel, { once: true })
      if (!this.active) entry.start()
      else {
        if (this.pending && this.pending.priority > priority) { signal?.removeEventListener('abort', cancel); reject(abortError()); return }
        this.pending?.cancel(); this.pending = entry
        if (priority >= this.active.priority) this.active.controller.abort()
      }
    })
  }
  cancel(): void { this.pending?.cancel(); this.pending = undefined; this.active?.controller.abort() }
  private drain(): void { const next = this.pending; this.pending = undefined; next?.start() }
}
export const completionCoordinator = new CompletionCoordinator()

export class RecentEditStore {
  private entries: Array<RecentEdit & { at: number; endOffset?: number }> = []
  add(fileId: string, before: string, after: string, origin: RecentEdit['origin'], at = Date.now(), offset?: number): void {
    if ((!before && !after) || before.length > 4096 || after.length > 4096) return
    const previous = this.entries.at(-1)
    if (offset != null && previous?.fileId === fileId && origin === 'typing' && previous.origin === origin &&
      !before && at - previous.at < 500 && previous.endOffset === offset && previous.after.length + after.length <= 4096) {
      previous.after += after; previous.at = at; previous.endOffset = offset + after.length
    } else this.entries.push({ fileId, before, after, origin, ageMs: 0, at, ...(offset == null ? {} : { endOffset: offset + after.length }) })
    this.entries = this.entries.filter(item => at - item.at <= 300_000).slice(-20)
    while (this.entries.reduce((total, item) => total + item.before.length + item.after.length, 0) > 16_384) this.entries.shift()
  }
  read(at = Date.now()): RecentEdit[] {
    return this.entries.filter(item => at - item.at <= 300_000 && item.origin !== 'undo' && item.origin !== 'redo')
      .map(({ at: time, endOffset: _offset, ...item }) => ({ ...item, ageMs: at - time }))
  }
  clear(): void { this.entries = [] }
}

const SOURCE = /\.(?:[cm]?[jt]sx?|[ch](?:pp|xx|\+\+)?|cc|hh|ino|py|rs|go|java|kt|cs|swift|m|mm|php|rb|lua|dart|vue|svelte|gd|glsl|hlsl|sh)$/i
const EXCLUDED = /(?:^|\/)(?:node_modules|libraries|vendor|dist|build|target|generated|\.build|\.pio|\.git|\.cache|\.venv|venv|__pycache__)(?:\/|$)|(?:^|\/)(?:\.env(?:\.|$)|credentials(?:\.|$)|secrets?(?:\.|$)|id_rsa(?:\.|$))|(?:\.min|\.generated)\.[^/]+$/i
export function isCompletionSource(path: string): boolean {
  return SOURCE.test(path) && !EXCLUDED.test(path.replace(/\\/g, '/'))
}
export function contentHash(value: string): string {
  // Identity only, never authorization. Acceptance also compares the exact text/version.
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16)
}
