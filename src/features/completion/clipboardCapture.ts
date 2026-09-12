import * as monaco from 'monaco-editor'
import type { CodeEditorWidget } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/widget/codeEditor/codeEditorWidget'
import { CLIPBOARD_TEXT_LIMIT, type ClipboardContext } from './suggestionProtocol'

/** Observe the pinned Workbench's native copy/cut payload, including empty-line
 * copy and multiple cursors. Never read or intercept the system clipboard. */
export function observeEditorClipboard(captured: (uri: string, text: string, operation: ClipboardContext['operation']) => void): monaco.IDisposable {
  const editors = new Map<string, monaco.IDisposable[]>()
  const attach = (editor: monaco.editor.ICodeEditor) => {
    if (editors.has(editor.getId())) return
    const native = editor as unknown as CodeEditorWidget
    let pending: { uri: string; version: number; text: string } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const capture = (text: string, operation: ClipboardContext['operation']) => {
      const model = editor.getModel()
      if (!model || !editor.hasTextFocus()) return
      pending = { uri: model.uri.toString(), version: model.getVersionId(), text: text.slice(0, CLIPBOARD_TEXT_LIMIT) }
      clearTimeout(timer)
      timer = setTimeout(() => { pending = undefined }, 0)
      captured(pending.uri, text, operation)
    }
    const subscriptions = [
      native.onWillCopy(event => capture(event.dataToCopy.text, event.isCut ? 'cut' : 'copy')),
      native.onWillCut(event => capture(event.dataToCopy.text, 'cut')),
      // Native EditContext runs cut as a copy event followed synchronously by a
      // cut transaction. Reuse its exact payload (selection order, EOL, empty
      // selection line) instead of reconstructing text from deletion ranges.
      native.onDidChangeModelContent(event => {
        const copy = pending
        pending = undefined
        if (copy && !event.isUndoing && !event.isRedoing && editor.getModel()?.uri.toString() === copy.uri &&
          event.versionId === copy.version + 1 && event.detailedReasons.some(reason => reason.metadata.source === 'cursor' && reason.metadata.kind === 'cut')) {
          captured(copy.uri, copy.text, 'cut')
        }
      }),
      { dispose: () => { clearTimeout(timer); pending = undefined } },
      editor.onDidDispose(() => { subscriptions.forEach(item => item.dispose()); editors.delete(editor.getId()) }),
    ]
    editors.set(editor.getId(), subscriptions)
  }
  monaco.editor.getEditors().forEach(attach)
  const created = monaco.editor.onDidCreateEditor(attach)
  return { dispose: () => { created.dispose(); editors.forEach(items => items.forEach(item => item.dispose())); editors.clear() } }
}
