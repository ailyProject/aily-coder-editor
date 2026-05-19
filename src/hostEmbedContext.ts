/**
 * Electron 宿主（Angular）通过 postMessage 注入通用上下文；与 native-fs 通道分离，专用于只读元数据。
 * 契约：父窗口 → iframe，仅处理 `ev.source === window.parent`。
 */

/** 主板 boardDependencies 解析出的 SDK / 编译器 / 工具（磁盘在 appdata/aily-project 下） */
export type HostPlatformPackageV1 = {
  id: string
  label: string
  packageName: string
  version: string
  kind: 'sdk' | 'compiler' | 'tool'
  absolutePath: string
  /** tools 下真实文件夹名，如 ctags@5.8-arduino11 */
  diskDirName?: string
}

/** 与 Angular `code-editor-pro` 发送的 payload 对齐；`v` 用于日后无损升级。 */
export type HostEmbedContextV1 = {
  v: 1
  /** 当前工作区根绝对路径（与 ?folder= 一致，便于对账） */
  workspaceRoot?: string
  /** Aily Code：`getBuildPath()` 得到的构建输出目录绝对路径 */
  buildPath?: string
  /**
   * 相对工作区根的 main.hex 路径（POSIX 斜杠），供 TreeItem / vscode.open 使用。
   */
  mainHexRelPath?: string
  /** 与 ProjectService.getBuildPath()+main.hex 一致的绝对路径（可能在工作区外，如 aily-builder 缓存目录） */
  mainHexAbsPath?: string
  /** 全局 aily-project（appdata）根路径，便于扩展侧对账 */
  appDataPath?: string
  /** Platform Packages 子节点：主板依赖的 sdk / compiler / tool 真实目录 */
  platformPackages?: readonly HostPlatformPackageV1[]
  /** 预留：版本号、板型等 */
  meta?: Record<string, unknown>
}

export const HOST_EMBED_CONTEXT_CHANNEL = 'aily-coder-host-context'

let snapshot: HostEmbedContextV1 | null = null
const listeners = new Set<() => void>()

/** 当前快照；扩展里只读。 */
export function getHostEmbedContext(): HostEmbedContextV1 | null {
  return snapshot
}

/** 宿主更新上下文时订阅（用于刷新 TreeDataProvider）。 */
export function onHostEmbedContextChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emitHostEmbedContextChanged(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* 避免单个听众拖垮扩展 */
    }
  }
}

/** 尽早注册：与 `installParentBackedNativeFsReplyListener` 同级别，在 workbench 启动前调用即可。 */
export function installHostEmbedContextListener(): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as { channel?: string; payload?: unknown }
    if (d?.channel !== HOST_EMBED_CONTEXT_CHANNEL) {
      return
    }
    if (!window.parent || ev.source !== window.parent) {
      return
    }
    const p = d.payload as HostEmbedContextV1
    if (p?.v === 1) {
      snapshot = p
      emitHostEmbedContextChanged()
    }
  })
}
