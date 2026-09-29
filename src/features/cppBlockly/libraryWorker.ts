import type { LibraryApi } from './libraryApi.js'
import type { LibraryHeader } from './libraryCatalog.js'

export function parseLibraryAsync(headers: LibraryHeader[]): { promise: Promise<LibraryApi>; cancel(): void } {
  const worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })
  let cancel = (): void => {}
  const promise = new Promise<LibraryApi>((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timeout); worker.terminate() }
    cancel = () => { cleanup(); reject(new Error('已取消库接口索引')) }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('库接口索引超时，请刷新项目库重试')) }, 15_000)
    worker.onmessage = (event: MessageEvent<{ api?: LibraryApi; error?: string }>) => { cleanup(); if (event.data.api) resolve(event.data.api); else reject(new Error(event.data.error)) }
    worker.onerror = () => { cleanup(); reject(new Error('库接口解析器启动失败')) }
    worker.postMessage({ id: 1, headers })
  })
  return { promise, cancel: () => cancel() }
}
