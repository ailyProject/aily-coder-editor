import type { PreviewDocument } from './editorSession.js'

export interface EditableSourceModel {
  getValue(): string
  getVersionId(): number
  isDisposed(): boolean
  pushStackElement(): void
  getFullModelRange(): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
  pushEditOperations(before: null, edits: Array<{ range: ReturnType<EditableSourceModel['getFullModelRange']>; text: string }>, after: () => null): unknown
}
// No await between revision checks and the undoable model transaction.
export function applySource(model: EditableSourceModel, expected: PreviewDocument, code: string): void {
  if (model.isDisposed() || model.getVersionId() !== expected.version || model.getValue() !== expected.text) throw new Error('源码已变化，积木草稿已保留。请复制生成代码，或放弃草稿后重新载入源码。')
  if (code === expected.text) return
  model.pushStackElement()
  model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: code }], () => null)
  model.pushStackElement()
}
