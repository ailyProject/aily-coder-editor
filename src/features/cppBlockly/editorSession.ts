import { generateCpp, mergeScope } from './generator.js'
import type { CppPreview, PreviewBlock } from './types.js'

export interface PreviewDocument { text: string; version: number; dirty: boolean }
export interface CppEditSession {
  source?: PreviewDocument
  original?: CppPreview
  roots: PreviewBlock[]
  scope: string
  view?: PreviewBlock[]
  dirty: boolean
  revision: number
}
export const createCppSession = (): CppEditSession => ({ roots: [], scope: '', dirty: false, revision: 0 })
export function sessionRoots(session: CppEditSession): PreviewBlock[] {
  return session.view ? mergeScope(session.roots, session.scope, session.view) : session.roots
}
export function sessionCode(session: CppEditSession): string {
  if (!session.source || !session.original) throw new Error('请等待源码转换完成。')
  return generateCpp(session.source.text, session.original, sessionRoots(session))
}
export function loadCppSession(session: CppEditSession, source: PreviewDocument, result: CppPreview): void {
  session.source = source; session.original = result; session.roots = structuredClone(result.blocks.blocks)
  session.view = undefined; session.dirty = false; session.revision++
}
export async function applyCppSession(session: CppEditSession, parse: (code: string) => Promise<CppPreview>, write: (code: string, expected: PreviewDocument, stillCurrent: () => boolean) => Promise<PreviewDocument>): Promise<void> {
  const revision = session.revision, source = session.source!
  const code = sessionCode(session)
  const result = await parse(code)
  if (revision !== session.revision) throw new Error('积木已继续变化，请重新应用当前修改。')
  if (result.status === 'error') throw new Error(`生成的 C++ 未通过语法检查：${result.diagnostics.map(d => `L${d.line}:${d.column} ${d.message}`).join('；')}`)
  const updated = await write(code, source, () => revision === session.revision)
  loadCppSession(session, updated, result)
}

export function parseCppAsync(source: string): { promise: Promise<CppPreview>; cancel(): void } {
  const worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })
  let cancel = (): void => {}
  const promise = new Promise<CppPreview>((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timeout); worker.terminate() }
    cancel = () => { cleanup(); reject(new Error('已取消转换')) }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('解析超时，请缩小文件后重试。')) }, 15_000)
    worker.onmessage = (e: MessageEvent<{result: CppPreview}>) => { cleanup(); resolve(e.data.result) }
    worker.onerror = () => { cleanup(); reject(new Error('C++ 解析器启动失败，请重试。')) }
    worker.postMessage({ id: 1, source })
  })
  return { promise, cancel: () => cancel() }
}
