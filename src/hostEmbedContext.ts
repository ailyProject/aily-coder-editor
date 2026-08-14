/**
 * Electron 宿主（Angular）通过 postMessage 注入通用上下文；与 native-fs 通道分离，专用于只读元数据。
 * 契约：父窗口 → iframe，仅处理 `ev.source === window.parent`。
 */

/** Blockly 主板「一板多类型」列表行（如 package.json 的 mode[]） */
export type HostBoardListItemV1 = {
  id: string
  label: string
  description?: string
  /** 当前工程选中的框架 / 类型 */
  selected?: boolean
}

/** 虚拟 Board 属性节点在内嵌编辑器中展示的概要 */
export type HostBoardProfileV1 = {
  boardName?: string
  boardNickname?: string
  /** 与 Blockly 主板包 mode 对齐；仅展示，切换仍走宿主弹窗 */
  frameworkModes?: readonly HostBoardListItemV1[]
}

/** 编译产物虚拟树节点（main.hex / main.bin / *.bootloader.bin / *.partitions.bin 等） */
export type HostBuildArtifactV1 = {
  label: string
  absPath: string
  /** 相对工作区根；工作区外产物可省略 */
  relPath?: string
}

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
  /** 磁盘上真实存在的编译产物列表（仅在有产物时由宿主写入） */
  buildArtifacts?: readonly HostBuildArtifactV1[]
  /**
   * 相对工作区根的 main.hex 路径（POSIX 斜杠），供 TreeItem / vscode.open 使用。
   * @deprecated 优先使用 buildArtifacts；保留以便旧版扩展兼容
   */
  mainHexRelPath?: string
  /** 与 ProjectService.getBuildPath()+main.hex 一致的绝对路径（可能在工作区外，如 aily-builder 缓存目录） */
  mainHexAbsPath?: string
  /** 全局 aily-project（appdata）根路径，便于扩展侧对账 */
  appDataPath?: string
  /** Platform Packages 子节点：主板依赖的 sdk / compiler / tool 真实目录 */
  platformPackages?: readonly HostPlatformPackageV1[]
  /** 虚拟 Board 节点：Blockly 主板支持的 framework / mode 列表 */
  boardProfile?: HostBoardProfileV1
  /** 宿主轻量上下文；theme 更新不应触发 Runtime 或 iframe 重启。 */
  meta?: Record<string, unknown> & { theme?: 'dark' | 'light' }
}

export const HOST_EMBED_CONTEXT_CHANNEL = 'aily-coder-host-context'

/** iframe → Angular：请求打开右上角库管理面板（与 Blockly 库管理 UI 同源） */
export const HOST_OPEN_LIBRARY_MANAGER_CHANNEL = 'aily-coder-open-library-manager'

/** 与 Angular code-editor-pro 中 AILY_EMBED_OPEN_LIBRARY_MANAGER_CHANNEL 须一致 */
export const AILY_EMBED_OPEN_LIBRARY_MANAGER_BC = 'aily-embed-open-library-manager'

/** iframe → Angular：请求打开切换开发板弹窗（与 Header board-select 同源） */
export const HOST_OPEN_BOARD_SELECTOR_CHANNEL = 'aily-coder-open-board-selector'

/** 与 Angular code-editor-pro 中 AILY_EMBED_OPEN_BOARD_SELECTOR_CHANNEL 须一致 */
export const AILY_EMBED_OPEN_BOARD_SELECTOR_BC = 'aily-embed-open-board-selector'

/** iframe → Angular：写入系统剪贴板（iframe 内 Clipboard API 常被 Permissions-Policy 禁用） */
export const HOST_CLIPBOARD_WRITE_CHANNEL = 'aily-coder-clipboard-write'

/** 与 Angular code-editor-pro 中 AILY_EMBED_CLIPBOARD_WRITE_CHANNEL 须一致 */
export const AILY_EMBED_CLIPBOARD_WRITE_BC = 'aily-embed-clipboard-write'

/** 与宿主同步库管理侧栏：`open` 为 true 展开，false 收起 */
export function syncHostLibraryManager(open: boolean): void {
  if (typeof window === 'undefined') {
    return
  }
  const payload = { channel: HOST_OPEN_LIBRARY_MANAGER_CHANNEL, open }
  if (window.parent != null && window.parent !== window) {
    try {
      window.parent.postMessage(payload, '*')
      return
    } catch {
      /* 落到 BroadcastChannel */
    }
  }
  if (typeof BroadcastChannel === 'undefined') {
    return
  }
  try {
    const ch = new BroadcastChannel(AILY_EMBED_OPEN_LIBRARY_MANAGER_BC)
    ch.postMessage({ open })
    setTimeout(() => {
      try {
        ch.close()
      } catch {
        /* ignore */
      }
    }, 1000)
  } catch {
    /* ignore */
  }
}

/** 向 Electron 宿主请求展开库管理侧栏 */
export function requestHostOpenLibraryManager(): void {
  syncHostLibraryManager(true)
}

/** 向 Electron 宿主请求收起库管理侧栏 */
export function requestHostCloseLibraryManager(): void {
  syncHostLibraryManager(false)
}

/** 向 Electron 宿主请求打开切换开发板弹窗 */
export function requestHostOpenBoardSelector(): void {
  if (typeof window === 'undefined') {
    return
  }
  const payload = { channel: HOST_OPEN_BOARD_SELECTOR_CHANNEL }
  if (window.parent != null && window.parent !== window) {
    try {
      window.parent.postMessage(payload, '*')
      return
    } catch {
      /* 落到 BroadcastChannel */
    }
  }
  if (typeof BroadcastChannel === 'undefined') {
    return
  }
  try {
    const ch = new BroadcastChannel(AILY_EMBED_OPEN_BOARD_SELECTOR_BC)
    ch.postMessage({})
    setTimeout(() => {
      try {
        ch.close()
      } catch {
        /* ignore */
      }
    }, 1000)
  } catch {
    /* ignore */
  }
}


/**
 * 将文本写入 Electron 宿主剪贴板。
 * 内嵌 iframe 中 `navigator.clipboard` / `vscode.env.clipboard` 常被 Permissions-Policy 拦截。
 * @returns 是否已委托宿主（postMessage 或 BroadcastChannel）
 */
export function requestHostClipboardWriteText(text: string): boolean {
  if (text == null || text === '') {
    return false
  }
  if (typeof window === 'undefined') {
    return false
  }
  const payload = { channel: HOST_CLIPBOARD_WRITE_CHANNEL, text }
  if (window.parent != null && window.parent !== window) {
    try {
      window.parent.postMessage(payload, '*')
      return true
    } catch {
      /* 落到 BroadcastChannel */
    }
  }
  if (typeof BroadcastChannel === 'undefined') {
    return false
  }
  try {
    const ch = new BroadcastChannel(AILY_EMBED_CLIPBOARD_WRITE_BC)
    ch.postMessage({ text })
    setTimeout(() => {
      try {
        ch.close()
      } catch {
        /* ignore */
      }
    }, 1000)
    return true
  } catch {
    return false
  }
}

let snapshot: HostEmbedContextV1 | null = null
const listeners = new Set<() => void>()

/** 当前快照；扩展里只读。 */
export function getHostEmbedContext(): HostEmbedContextV1 | null {
  return snapshot
}

/** 将 hints / 延后解析的 boardProfile 合并进快照并通知订阅方 */
export function mergeBoardProfileIntoSnapshot(boardProfile: HostBoardProfileV1): void {
  const modes = boardProfile.frameworkModes
  if (modes == null || modes.length === 0) {
    return
  }
  snapshot = {
    v: 1,
    ...snapshot,
    boardProfile
  }
  emitHostEmbedContextChanged()
}

/** Board 列表编辑器展示契约（与 ailyBoardListEditor 对齐） */
export type HostBoardListSpec = {
  readonly title: string
  readonly subtitle?: string
  readonly items: readonly HostBoardListItemV1[]
}

/** boardProfile → Board 列表编辑器 spec */
export function boardProfileToListSpec(bp: HostBoardProfileV1): HostBoardListSpec | null {
  const items = bp.frameworkModes
  if (items == null || items.length === 0) {
    return null
  }
  return {
    title: 'Board',
    subtitle: bp.boardNickname?.trim() || bp.boardName?.trim() || undefined,
    items
  }
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
