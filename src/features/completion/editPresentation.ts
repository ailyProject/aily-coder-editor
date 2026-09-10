import * as monaco from 'monaco-editor'
import type { EditorSnapshot } from './suggestionContext'
import type { Suggestion, TextEdit } from './suggestionProtocol'
import { comparePosition } from './suggestionProtocol'
import styles from './completion.css?inline'

const nativeRange = (edit: TextEdit) => new monaco.Range(edit.range.start.line + 1, edit.range.start.character + 1, edit.range.end.line + 1, edit.range.end.character + 1)
/** Synchronous model-level transaction: no await between checks and pushEditOperations. */
export function applySuggestion(snapshot: EditorSnapshot, candidate: Suggestion): boolean {
  if (candidate.fileId !== snapshot.request.active.fileId || candidate.snapshotId !== snapshot.request.active.snapshotId) return false
  const model = monaco.editor.getModels().find(item => item.uri.toString() === snapshot.document.uri.toString())
  if (!model || model.isDisposed() || model.getValue() !== snapshot.text || snapshot.document.getText() !== snapshot.text) return false
  if (monaco.editor.getEditors().some(editor => editor.getModel() === model && editor.getOption(monaco.editor.EditorOption.readOnly))) return false
  const edits = [candidate.primary, ...candidate.additionalEdits]
  const sorted = [...edits].sort((a, b) => comparePosition(a.range.start, b.range.start))
  for (let index = 1; index < sorted.length; index++) {
    if (comparePosition(sorted[index - 1]!.range.end, sorted[index]!.range.start) >= 0) return false
  }
  for (const edit of edits) {
    const range = nativeRange(edit)
    if (!model.validateRange(range).equalsRange(range) || model.getValueInRange(range) !== edit.expectedText) return false
  }
  model.pushStackElement()
  model.pushEditOperations(null, edits.map(edit => ({ range: nativeRange(edit), text: edit.newText, forceMoveMarkers: true })), () => null)
  model.pushStackElement()
  return true
}

export class EditPresentation {
  private editor?: monaco.editor.ICodeEditor
  private decorations?: monaco.editor.IEditorDecorationsCollection
  private zone?: string
  private style?: HTMLStyleElement
  clear(): void {
    this.style?.remove(); this.style = undefined
    this.decorations?.clear(); this.decorations = undefined
    if (this.zone && this.editor) { const zone = this.zone; this.editor.changeViewZones(accessor => accessor.removeZone(zone)) }
    this.zone = undefined; this.editor = undefined
  }
  show(snapshot: EditorSnapshot, candidate: Suggestion, collapsed: boolean, accept: () => void, reject: () => void): void {
    this.clear()
    const editor = monaco.editor.getEditors().find(item => item.getModel()?.uri.toString() === snapshot.document.uri.toString() && item.hasTextFocus())
      ?? monaco.editor.getEditors().find(item => item.getModel()?.uri.toString() === snapshot.document.uri.toString())
    if (!editor) return
    this.editor = editor
    const tree = editor.getDomNode()?.getRootNode()
    this.style = document.createElement('style'); this.style.textContent = styles
    ;(tree instanceof ShadowRoot ? tree : document.head).appendChild(this.style)
    const end = candidate.primary.range.end
    const lastLine = end.character === 0 && end.line > candidate.primary.range.start.line ? end.line : end.line + 1
    const decorationRange = new monaco.Range(candidate.primary.range.start.line + 1, candidate.primary.range.start.character + 1,
      lastLine, lastLine === end.line ? editor.getModel()!.getLineMaxColumn(lastLine) : end.character + 1)
    this.decorations = editor.createDecorationsCollection([{ range: decorationRange, options: {
      isWholeLine: true, linesDecorationsClassName: 'aily-next-edit-gutter',
      className: collapsed ? undefined : 'aily-next-edit-original',
      hoverMessage: { value: `下一处编辑建议 · 第 ${candidate.primary.range.start.line + 1} 行\n\nTab 定位/接受，Esc 拒绝。` },
    } }])
    const root = document.createElement('div'); root.className = 'aily-next-edit-preview'
    const header = document.createElement('div'); header.className = 'aily-next-edit-header'
    const label = document.createElement('span'); label.textContent = `下一处编辑 · 第 ${candidate.primary.range.start.line + 1} 行`; header.append(label)
    for (const [text, action] of [[collapsed ? '展开并定位 (Tab)' : '接受 (Tab)', accept], ['拒绝 (Esc)', reject]] as const) {
      const button = document.createElement('button'); button.textContent = text; button.onclick = event => { event.stopPropagation(); action() }; header.append(button)
    }
    root.append(header)
    const edits = [candidate.primary, ...candidate.additionalEdits]
    if (!collapsed) {
      for (const edit of edits) {
        if (edit.expectedText) { const before = document.createElement('pre'); before.className = 'aily-next-edit-deleted'; before.textContent = edit.expectedText; root.append(before) }
        const after = document.createElement('pre'); after.className = 'aily-next-edit-added'; after.textContent = edit.newText || '（删除）'; root.append(after)
      }
    }
    const lineCount = edits.reduce((total, edit) => total + edit.expectedText.split('\n').length + edit.newText.split('\n').length, 0)
    editor.changeViewZones(accessor => { this.zone = accessor.addZone({ afterLineNumber: lastLine, heightInLines: collapsed ? 2 : Math.min(14, lineCount + 2), domNode: root, suppressMouseDown: true }) })
  }
}
