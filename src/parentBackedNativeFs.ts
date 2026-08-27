/**
 * Electron 宿主内嵌 Coder 时，通过 window.parent.postMessage 将磁盘读写交给外层 Angular（preload fs）。
 */

import { Emitter, Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { newWriteableStream } from '@codingame/monaco-vscode-api/vscode/vs/base/common/stream'
import { VSBuffer } from '@codingame/monaco-vscode-api/vscode/vs/base/common/buffer'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import {
  FileChangeType,
  FileType,
  FileSystemProviderCapabilities,
  createFileSystemProviderError,
  FileSystemProviderErrorCode,
  isFileOpenForWriteOptions
} from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'
import type { IFileChange } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'
import {
  NativeFsWatchEchoSuppressor,
  resolveNativeFsWatchTargetPath
} from './nativeFsWatchEvent.js'

const CHANNEL = 'aily-coder-native-fs'
export const CODEMBED_NATIVE_FS_REPLY = 'aily-coder-native-fs-reply'
/** 宿主 → iframe：磁盘 watch 事件推送 */
export const CODEMBED_NATIVE_FS_WATCH_EVENT = 'aily-coder-native-fs-watch-event'

export interface NativeFsWatchEventPayload {
  watchId?: number
  eventType?: string
  filename?: string
  error?: string
}

export type NativeFsWatchCallback = (ev: NativeFsWatchEventPayload) => void

const watchCallbacksById = new Map<number, NativeFsWatchCallback>()

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (e: unknown) => void
}

const pendingById = new Map<number, PendingEntry>()
let requestSeq = 0
let replyListenerInstalled = false
let watchListenerInstalled = false
const nativeFsWatchEchoSuppressor = new NativeFsWatchEchoSuppressor()

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let result = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    let chunkStr = ''
    for (let j = 0; j < chunk.length; j++) {
      chunkStr += String.fromCharCode(chunk[j] ?? 0)
    }
    result += chunkStr
  }
  return btoa(result)
}

export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  return bytes
}

/** 经宿主校验绝对路径是否为普通文件（含 aily-builder 全局编译缓存目录） */
export async function statAbsolutePathViaHost(
  absPath: string
): Promise<{ exists: boolean; isFile: boolean }> {
  if (!absPath?.trim() || !window.parent || window.parent === window) {
    return { exists: false, isFile: false }
  }
  try {
    const r = await rpc<{
      exists: boolean
      _isFile?: boolean
      _isDirectory?: boolean
    }>('nativeFsStat', { path: absPath.trim() })
    return { exists: !!r.exists, isFile: !!r._isFile && !r._isDirectory }
  } catch {
    return { exists: false, isFile: false }
  }
}

function rpc<T>(op: string, payload: Record<string, unknown>, timeoutMs = 120000): Promise<T> {
  if (!window.parent || window.parent === window) {
    return Promise.reject(new Error('Coder：无父窗口，无法调用本地文件系统'))
  }
  const id = ++requestSeq
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pendingById.delete(id)) {
        reject(new Error(`Coder 本地 FS 超时: ${op}`))
      }
    }, timeoutMs)
    pendingById.set(id, {
      resolve: (v: unknown) => {
        window.clearTimeout(timer)
        resolve(v as T)
      },
      reject: (e: unknown) => {
        window.clearTimeout(timer)
        reject(e)
      }
    })
    window.parent.postMessage({ channel: CHANNEL, id, op, payload }, '*')
  })
}

export type NativeGitStatusResult = {
  /** Older hosts omit this field for initialized repositories. */
  initialized?: boolean
  /** 兼容旧宿主；当前 SCM 只消费 initialized 与 status。 */
  repositoryRoot?: string
  status: string
}

export type NativeGitHistoryRef = {
  id: string
  name: string
  revision: string
  category: 'head' | 'local' | 'remote' | 'tag'
}

export type NativeGitHistoryRefsResult = {
  current?: NativeGitHistoryRef
  remote?: NativeGitHistoryRef
  refs: NativeGitHistoryRef[]
}

export type NativeGitHistoryItemsOptions = {
  revisions?: string[]
  skip?: number
  limit?: number
  filterText?: string
}

/** 读取当前工作区 Git 状态；宿主只执行固定的只读 Git 参数。 */
export function readNativeGitStatus(workspaceRoot: string): Promise<NativeGitStatusResult> {
  return rpc<NativeGitStatusResult>('nativeGitStatus', { workspaceRoot })
}

/** 在当前 Coder 工程根初始化 Git 仓库。仅由用户点击 SCM 初始化入口触发。 */
export function initializeNativeGitRepository(
  workspaceRoot: string
): Promise<{ summary: string }> {
  return rpc<{ summary: string }>('nativeGitInit', { workspaceRoot })
}

/** 读取 HEAD、分支、远端分支和标签，供原生 SCM Graph 使用。 */
export function readNativeGitHistoryRefs(
  workspaceRoot: string
): Promise<NativeGitHistoryRefsResult> {
  return rpc<NativeGitHistoryRefsResult>('nativeGitHistoryRefs', { workspaceRoot })
}

/** 分页读取提交拓扑；返回 NUL 分隔记录，避免提交消息中的换行破坏解析。 */
export function readNativeGitHistoryItems(
  workspaceRoot: string,
  options: NativeGitHistoryItemsOptions
): Promise<{ history: string }> {
  return rpc<{ history: string }>('nativeGitHistoryItems', { workspaceRoot, ...options })
}

/** 读取两个提交之间的文件状态，返回 `git --name-status -z` 原文。 */
export function readNativeGitHistoryItemChanges(
  workspaceRoot: string,
  historyItemId: string,
  historyItemParentId?: string
): Promise<{ changes: string }> {
  return rpc<{ changes: string }>('nativeGitHistoryItemChanges', {
    workspaceRoot,
    historyItemId,
    historyItemParentId
  })
}

/** 解析多个历史引用的共同祖先。 */
export function resolveNativeGitHistoryCommonAncestor(
  workspaceRoot: string,
  revisions: string[]
): Promise<{ revision?: string }> {
  return rpc<{ revision?: string }>('nativeGitHistoryMergeBase', {
    workspaceRoot,
    revisions
  })
}

/** 延迟读取指定提交中的文本内容，供 Graph 展开后的历史 diff 使用。 */
export function readNativeGitRevisionFile(
  workspaceRoot: string,
  revision: string,
  relativePath: string
): Promise<{ content: string }> {
  return rpc<{ content: string }>('nativeGitShowRevisionFile', {
    workspaceRoot,
    revision,
    relativePath
  })
}

/** 从 HEAD 读取工作区相对路径的基线文本，供 SCM diff 使用。 */
export function readNativeGitHeadFile(
  workspaceRoot: string,
  relativePath: string
): Promise<{ content: string }> {
  return rpc<{ content: string }>('nativeGitShowHead', { workspaceRoot, relativePath })
}

/** 保存并提交当前工作区变更；未初始化时宿主会先建仓，并排除生成与依赖目录。 */
export function commitNativeGitChanges(
  workspaceRoot: string,
  message: string
): Promise<{ summary: string }> {
  return rpc<{ summary: string }>('nativeGitCommit', { workspaceRoot, message })
}

/** 挂载一次应答监听（setup.common 内尽早调用）。 */
export function installParentBackedNativeFsReplyListener(): void {
  if (replyListenerInstalled) return
  replyListenerInstalled = true
  window.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data
    if (d?.channel !== CODEMBED_NATIVE_FS_REPLY) {
      return
    }
    const id = typeof d.id === 'number' ? d.id : 0
    const entry = pendingById.get(id)
    if (!entry) {
      return
    }
    pendingById.delete(id)
    if (d.error) {
      entry.reject(new Error(String(d.error)))
      return
    }
    entry.resolve(d.result)
  })
}

/**
 * 在工程根注册递归 nativeFs watch（复制/删除/移动等系统级变更）。
 * 返回 dispose；无父窗口时 resolve 空 dispose。
 */
export async function startWorkspaceNativeWatch(
  workspaceRootAbs: string,
  onEvent: NativeFsWatchCallback
): Promise<() => void> {
  if (!window.parent || window.parent === window) {
    return () => {}
  }
  const { watchId } = await rpc<{ watchId: number }>('nativeFsWatchStart', {
    path: workspaceRootAbs,
    recursive: true
  })
  watchCallbacksById.set(watchId, onEvent)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    watchCallbacksById.delete(watchId)
    void rpc('nativeFsWatchStop', { watchId }).catch(() => {})
  }
}

/** 是否应刷新 Start Here（src 下 .cpp 增删改；filename 为空时保守刷新） */
export function shouldRefreshStartHereNativeWatch(filename: string | undefined): boolean {
  if (filename == null || filename.trim().length === 0) {
    return true
  }
  const norm = filename.replace(/\\/g, '/').toLowerCase()
  return (
    norm.endsWith('.cpp') ||
    norm.includes('/src/') ||
    norm.startsWith('src/') ||
    norm === 'src' ||
    norm.endsWith('/src')
  )
}

/** 是否应刷新 Build Outputs 下编译产物虚拟节点（.aily/build 与 coder-embed-hints 变更） */
export function shouldRefreshBuildOutputsNativeWatch(
  filename: string | undefined
): boolean {
  if (filename == null || filename.trim().length === 0) {
    return false
  }
  const norm = filename.replace(/\\/g, '/').toLowerCase()
  return (
    norm.includes('/.aily/build/') ||
    norm.startsWith('.aily/build/') ||
    norm.endsWith('/.aily/build') ||
    norm === '.aily/build' ||
    norm.endsWith('/coder-embed-hints.json') ||
    norm === 'coder-embed-hints.json'
  )
}

/** 挂载宿主 push 的 fs.watch 事件（与 reply listener 同级尽早调用）。 */
export function installParentBackedNativeFsWatchListener(): void {
  if (watchListenerInstalled) return
  watchListenerInstalled = true
  window.addEventListener('message', (ev: MessageEvent) => {
    if (!window.parent || ev.source !== window.parent) {
      return
    }
    const d = ev.data as { channel?: string; watchId?: number }
    if (d?.channel !== CODEMBED_NATIVE_FS_WATCH_EVENT || typeof d.watchId !== 'number') {
      return
    }
    watchCallbacksById.get(d.watchId)?.(d as NativeFsWatchEventPayload)
  })
}

function mapWatchEventToFileChanges(
  watchRoot: string,
  ev: NativeFsWatchEventPayload,
): IFileChange[] {
  const targetPath = resolveNativeFsWatchTargetPath(watchRoot, ev)
  if (!targetPath || nativeFsWatchEchoSuppressor.shouldSuppress(targetPath)) return []
  return [{ type: FileChangeType.UPDATED, resource: URI.file(targetPath) }]
}

function assertUnderRoot(rootNorm: string, fsPathNorm: string): void {
  const r = rootNorm.replace(/\\/g, '/').toLowerCase()
  const tail = '/'
  let p = fsPathNorm.replace(/\\/g, '/').toLowerCase()
  if (p.startsWith('/') && /^\/[a-zA-Z]:/.test(p)) {
    p = p.slice(1)
  }
  const base = r.endsWith(tail) ? r.slice(0, -1) : r
  const full = p.endsWith(tail) ? p.slice(0, -1) : p
  if (full === base) {
    return
  }
  const prefix = base + tail
  if (!full.startsWith(prefix)) {
    throw createFileSystemProviderError(
      'path outside workspace',
      FileSystemProviderErrorCode.NoPermissions,
    )
  }
}

function normalizeFsPathSep(p: string): string {
  let s = p.replace(/\\/g, '/')
  if (s.startsWith('/') && /^\/[a-zA-Z]:\//.test(s)) {
    s = s.slice(1)
  }
  return s
}

type OpenFd = {
  path: string
  buffer: Uint8Array
  dirty: boolean
  write: boolean
  append: boolean
}

/** 仅处理 rootFsPathNormalized 之下的 file: URI。 */
export class ParentBackedNativeFsProvider {
  private fdCounter = 0
  private readonly fdMap = new Map<number, OpenFd>()

  readonly onDidChangeCapabilities = Event.None
  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.FileOpenReadWriteClose |
    FileSystemProviderCapabilities.FileAppend |
    FileSystemProviderCapabilities.PathCaseSensitive |
    FileSystemProviderCapabilities.FileReadStream

  private readonly _onDidChangeFile = new Emitter<readonly IFileChange[]>()
  readonly onDidChangeFile = this._onDidChangeFile.event

  constructor(private readonly rootFsPathNormalized: string) {}

  private uriPath(resource: URI): string {
    return normalizeFsPathSep(resource.fsPath)
  }

  async stat(resource: URI) {
    const p = this.uriPath(resource)
    assertUnderRoot(this.rootFsPathNormalized, p)
    const r = await rpc<{
      exists: boolean
      _isDirectory?: boolean
      _isFile?: boolean
      size: number
      mtimeMs: number
    }>('nativeFsStat', { path: p })
    if (!r.exists) {
      throw createFileSystemProviderError('Not found', FileSystemProviderErrorCode.FileNotFound)
    }
    return {
      type: r._isDirectory ? FileType.Directory : FileType.File,
      ctime: r.mtimeMs,
      mtime: r.mtimeMs,
      size: r.size
    }
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const dir = this.uriPath(resource)
    assertUnderRoot(this.rootFsPathNormalized, dir)
    const list = await rpc<Array<{ name: string; _isDirectory: boolean }>>('nativeFsReaddir', {
      path: dir
    })
    return list.map((x) => [x.name, x._isDirectory ? FileType.Directory : FileType.File])
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const p = this.uriPath(resource)
    assertUnderRoot(this.rootFsPathNormalized, p)
    const out = await rpc<{ base64: string }>('nativeFsReadBinary', { path: p })
    return base64ToBytes(out.base64)
  }

  readFileStream(resource: URI) {
    const stream = newWriteableStream<Uint8Array>((parts: readonly Uint8Array[]) =>
      VSBuffer.concat(parts.map((d) => VSBuffer.wrap(d))).buffer,
    )
    void this.readFile(resource)
      .then((bytes) => stream.end(bytes))
      .catch((err) => stream.error(err))
    return stream
  }

  async writeFile(resource: URI, content: Uint8Array) {
    const p = this.uriPath(resource)
    assertUnderRoot(this.rootFsPathNormalized, p)
    await this.runLocalMutation([p], () =>
      rpc('nativeFsWriteBinary', { path: p, base64: bytesToBase64(content) })
    )
    this._fire({ type: FileChangeType.UPDATED, resource })
  }

  /* eslint-disable @typescript-eslint/no-explicit-any -- VSCode open 选项较宽 */
  async open(resource: URI, opts: any) {
    const p = this.uriPath(resource)
    assertUnderRoot(this.rootFsPathNormalized, p)
    const write = isFileOpenForWriteOptions(opts)
    const append = !!(write && opts.append)
    let buffer = new Uint8Array(0)
    const st = await rpc<{ exists: boolean; _isDirectory?: boolean }>('nativeFsStat', { path: p })
    if (st.exists && st._isDirectory) {
      throw createFileSystemProviderError('Is directory', FileSystemProviderErrorCode.FileIsADirectory)
    }
    if (!st.exists) {
      if (!(write && opts.create)) {
        throw createFileSystemProviderError('Not found', FileSystemProviderErrorCode.FileNotFound)
      }
    } else if (!write) {
      buffer = new Uint8Array(await this.readFile(resource))
    } else if (!append) {
      buffer = new Uint8Array(await this.readFile(resource))
    }
    const fd = ++this.fdCounter
    this.fdMap.set(fd, { path: p, buffer, dirty: false, write, append })
    return fd
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  async close(fd: number) {
    const rec = this.fdMap.get(fd)
    if (!rec) {
      return
    }
    this.fdMap.delete(fd)
    if (rec.dirty && rec.write) {
      await this.runLocalMutation([rec.path], () =>
        rpc('nativeFsWriteBinary', {
          path: rec.path,
          base64: bytesToBase64(rec.buffer)
        })
      )
      this._fire({ type: FileChangeType.UPDATED, resource: URI.file(rec.path) })
    }
  }

  async read(fd: number, pos: number, data: Uint8Array, offset: number, length: number) {
    const rec = this.fdMap.get(fd)
    if (!rec) {
      throw createFileSystemProviderError('Bad fd', FileSystemProviderErrorCode.Unavailable)
    }
    const end = Math.min(pos + length, rec.buffer.length)
    const n = Math.max(0, end - pos)
    if (n > 0) {
      data.set(rec.buffer.subarray(pos, pos + n), offset)
    }
    return n
  }

  async write(fd: number, pos: number, data: Uint8Array, offset: number, length: number) {
    const rec = this.fdMap.get(fd)
    if (!rec || !rec.write) {
      throw createFileSystemProviderError('Bad fd', FileSystemProviderErrorCode.Unavailable)
    }
    const chunk = data.subarray(offset, offset + length)
    const append = rec.append
    const writePos = append ? rec.buffer.byteLength : pos
    const endPos = writePos + chunk.byteLength
    if (endPos > rec.buffer.byteLength) {
      const next = new Uint8Array(endPos)
      next.set(rec.buffer, 0)
      rec.buffer = next
    }
    rec.buffer.set(chunk, writePos)
    rec.dirty = true
    return chunk.byteLength
  }

  async mkdir(resource: URI) {
    const p = this.uriPath(resource)
    assertUnderRoot(this.rootFsPathNormalized, p)
    await this.runLocalMutation([p], () => rpc('nativeFsMkdir', { path: p }))
    this._fire({ type: FileChangeType.ADDED, resource })
  }

  async delete(resource: URI, opts: { recursive?: boolean }) {
    const p = this.uriPath(resource)
    assertUnderRoot(this.rootFsPathNormalized, p)
    await this.runLocalMutation([p], () =>
      rpc('nativeFsDelete', { path: p, recursive: !!opts.recursive })
    )
    this._fire({ type: FileChangeType.DELETED, resource })
  }

  async rename(from: URI, to: URI, opts: { overwrite?: boolean }) {
    const fp = this.uriPath(from)
    const tp = this.uriPath(to)
    assertUnderRoot(this.rootFsPathNormalized, fp)
    assertUnderRoot(this.rootFsPathNormalized, tp)
    await this.runLocalMutation([fp, tp], () =>
      rpc('nativeFsRename', { oldPath: fp, newPath: tp, overwrite: !!opts.overwrite })
    )
    this._fire(
      { type: FileChangeType.DELETED, resource: from },
      { type: FileChangeType.ADDED, resource: to },
    )
  }

  watch(resource: URI, opts: { recursive?: boolean; excludes?: readonly string[] }) {
    const path = this.uriPath(resource)
    const recursive = !!opts?.recursive
    let watchId: number | undefined
    let disposed = false

    const disposeWatch = () => {
      if (disposed) {
        return
      }
      disposed = true
      if (watchId !== undefined) {
        watchCallbacksById.delete(watchId)
        void rpc('nativeFsWatchStop', { watchId })
      }
    }

    void rpc<{ watchId: number }>('nativeFsWatchStart', { path, recursive })
      .then(({ watchId: id }) => {
        if (disposed) {
          void rpc('nativeFsWatchStop', { watchId: id })
          return
        }
        watchId = id
        watchCallbacksById.set(id, (ev) => {
          const changes = mapWatchEventToFileChanges(path, ev)
          if (changes.length > 0) {
            this._fire(...changes)
          }
        })
      })
      .catch(() => {
        /* 宿主 fs.watch 不可用时静默降级 */
      })

    return { dispose: disposeWatch }
  }

  private _fire(...changes: IFileChange[]) {
    this._onDidChangeFile.fire(changes)
  }

  private async runLocalMutation<T>(paths: string[], task: () => Promise<T>): Promise<T> {
    paths.forEach((path) => nativeFsWatchEchoSuppressor.mark(path))
    try {
      return await task()
    } catch (error) {
      paths.forEach((path) => nativeFsWatchEchoSuppressor.forget(path))
      throw error
    }
  }
}

/** 经宿主 native-fs 桥读取磁盘二进制（供 workbench 侧无法 import IFileService 的场景） */
export async function readNativeFsBinary(absPath: string): Promise<Uint8Array | null> {
  if (!window.parent || window.parent === window) {
    return null
  }
  try {
    const out = await rpc<{ base64: string }>('nativeFsReadBinary', { path: absPath })
    return base64ToBytes(out.base64)
  } catch {
    return null
  }
}
