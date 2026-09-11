import {
  resolveNativeFsWatchTargetPath,
  type NativeFsWatchPathEvent
} from './nativeFsWatchEvent.js'

export type NativeFsOpenModel = {
  path: string
  dirty: boolean
}

export type NativeFsExternalModelSyncBridge = {
  listOpenModels(): NativeFsOpenModel[]
  reloadCleanModel(path: string): Promise<void>
  renderVisibleEditors(): void
}

type TimerHandle = ReturnType<typeof setTimeout>

export type NativeFsExternalModelSyncTimers = {
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

const defaultTimers: NativeFsExternalModelSyncTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle)
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  if (normalized.startsWith('/') && /^\/[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.slice(1)
  }
  return normalized
}

function pathKey(path: string, caseSensitive: boolean): string {
  const normalized = normalizePath(path)
  return caseSensitive ? normalized : normalized.toLowerCase()
}

function isWindowsRoot(path: string): boolean {
  return /^[a-zA-Z]:\//.test(normalizePath(path))
}

function equalOrParent(path: string, parent: string, caseSensitive: boolean): boolean {
  const candidate = pathKey(path, caseSensitive)
  const base = pathKey(parent, caseSensitive)
  return candidate === base || candidate.startsWith(`${base}/`)
}

/**
 * Resolve the open models affected by a native watcher event. A missing filename
 * means the watcher only identified the directory, so every open model below the
 * watched root must be reconciled instead of emitting an ineffective directory
 * UPDATED event and waiting for a later focus/click refresh.
 */
export function selectNativeFsOpenModelsToRefresh(
  watchRoot: string,
  event: NativeFsWatchPathEvent,
  models: NativeFsOpenModel[]
): string[] {
  const target = resolveNativeFsWatchTargetPath(watchRoot, event)
  if (!target) return []

  const caseSensitive = !isWindowsRoot(watchRoot)
  const rootEvent = !event.filename?.trim()
    || pathKey(target, caseSensitive) === pathKey(watchRoot, caseSensitive)

  return models
    .filter(model => !model.dirty)
    .filter(model => equalOrParent(model.path, watchRoot, caseSensitive))
    .filter(model => rootEvent || equalOrParent(model.path, target, caseSensitive))
    .map(model => normalizePath(model.path))
}

/**
 * Coalesces duplicate fs.watch bursts and retries transient reads around Windows
 * atomic replacement. Reloading is always guarded by the model's current dirty
 * state in the production bridge, so an unsaved user edit is never overwritten.
 */
export class NativeFsExternalModelSync {
  private readonly pending = new Map<string, TimerHandle>()
  private disposed = false

  constructor(
    private readonly bridge: NativeFsExternalModelSyncBridge,
    private readonly timers: NativeFsExternalModelSyncTimers = defaultTimers,
    private readonly initialDelayMs = 40,
    private readonly retryDelayMs = [80, 160, 320]
  ) {}

  handle(watchRoot: string, event: NativeFsWatchPathEvent): void {
    if (this.disposed) return
    const paths = selectNativeFsOpenModelsToRefresh(
      watchRoot,
      event,
      this.bridge.listOpenModels()
    )
    for (const path of paths) this.schedule(path, this.initialDelayMs, 0)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.pending.values()) this.timers.clearTimeout(timer)
    this.pending.clear()
  }

  private schedule(path: string, delayMs: number, attempt: number): void {
    const key = pathKey(path, !isWindowsRoot(path))
    const existing = this.pending.get(key)
    if (existing != null) this.timers.clearTimeout(existing)
    const timer = this.timers.setTimeout(() => {
      this.pending.delete(key)
      void this.reload(path, attempt)
    }, delayMs)
    this.pending.set(key, timer)
  }

  private async reload(path: string, attempt: number): Promise<void> {
    if (this.disposed) return
    try {
      await this.bridge.reloadCleanModel(path)
      if (!this.disposed) this.bridge.renderVisibleEditors()
    } catch {
      const retryDelay = this.retryDelayMs[attempt]
      if (retryDelay != null && !this.disposed) {
        this.schedule(path, retryDelay, attempt + 1)
      }
    }
  }
}
