export type NativeFsWatchPathEvent = {
  eventType?: string
  filename?: string
}

function normalizePath(value: string): string {
  let normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') && /^\/[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.slice(1)
  }
  return normalized
}

/** 抑制宿主 watcher 对当前文件提供器写盘操作的短期回声。 */
export class NativeFsWatchEchoSuppressor {
  private readonly recentUntilByPath = new Map<string, number>()

  constructor(
    private readonly windowMs = 500,
    private readonly now: () => number = Date.now
  ) {}

  mark(path: string): void {
    const now = this.now()
    this.prune(now)
    this.recentUntilByPath.set(normalizePath(path), now + this.windowMs)
  }

  forget(path: string): void {
    this.recentUntilByPath.delete(normalizePath(path))
  }

  shouldSuppress(path: string): boolean {
    const key = normalizePath(path)
    const now = this.now()
    const until = this.recentUntilByPath.get(key) ?? 0
    if (until <= now) {
      this.recentUntilByPath.delete(key)
      return false
    }
    return true
  }

  private prune(now: number): void {
    for (const [path, until] of this.recentUntilByPath) {
      if (until <= now) this.recentUntilByPath.delete(path)
    }
  }
}

/**
 * 将宿主 `fs.watch` 事件还原为工作区绝对路径。
 *
 * macOS 的递归 watcher 在子目录变化时会额外上报一次工作区目录名；该事件表示
 * watch 根本身，并不是同名子文件。错误事件也不能伪装成根目录文件变化。
 */
export function resolveNativeFsWatchTargetPath(
  watchRoot: string,
  event: NativeFsWatchPathEvent,
): string | undefined {
  const root = normalizePath(watchRoot).replace(/\/$/, '')
  if (!root || event.eventType?.toLowerCase() === 'error') {
    return undefined
  }

  const filename = normalizePath(event.filename ?? '').replace(/^\.\//, '').replace(/\/$/, '')
  if (!filename) {
    return root
  }
  if (filename.startsWith('/') || /^[a-zA-Z]:\//.test(filename)) {
    return filename
  }

  const rootName = root.slice(root.lastIndexOf('/') + 1)
  if (event.eventType?.toLowerCase() === 'change' && filename === rootName) {
    return root
  }
  return `${root}/${filename}`
}
