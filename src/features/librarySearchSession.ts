import type { HostEmbedContextV1 } from '../hostEmbedContext'

/** Theme, loading and ready replays do not change a library query. */
export function libraryContextKey(context: HostEmbedContextV1 | null | undefined): string {
  return JSON.stringify([context?.workspaceRoot, context?.boardProfile, context?.platformPackages])
}

/** Share an identical in-flight page; cache only the view's last successful page. */
export class LibrarySearchSession<T> {
  private pending = new Map<string, Promise<T>>()
  private last?: { key: string; value: T }
  private generation = 0
  invalidate(): void { this.generation++; this.last = undefined; this.pending.clear() }
  async load(key: string, request: () => Promise<T>, force = false): Promise<T> {
    const pending = this.pending.get(key)
    if (pending) return pending
    if (!force && this.last?.key === key) return this.last.value
    const generation = this.generation
    const task = request().then(value => { if (generation === this.generation) this.last = { key, value }; return value })
    this.pending.set(key, task)
    try { return await task } finally { if (this.pending.get(key) === task) this.pending.delete(key) }
  }
}
