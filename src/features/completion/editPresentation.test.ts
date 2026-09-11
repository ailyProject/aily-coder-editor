import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import type { EditorSnapshot } from './suggestionContext'
import type { Suggestion } from './suggestionProtocol'
import { contentHash } from './completionState'

// Model transaction boundary tests. The browser/Electron smoke verifies native undo separately.
class Range {
  constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}
  equalsRange(other: Range) { return JSON.stringify(this) === JSON.stringify(other) }
}
const code = buildSync({ entryPoints: [new URL('./editPresentation.ts', import.meta.url).pathname], bundle: true,
  write: false, format: 'cjs', platform: 'node', external: ['monaco-editor', '@codingame/monaco-vscode-api', '@codingame/monaco-vscode-api/*', '*.css?inline'] }).outputFiles[0]!.text
function setup() {
  const uri = { toString: () => 'file:///workspace/main.cpp' }; let text = 'int oldName = 0;\n'; let readOnly = false
  const calls: string[] = []; let operations: Array<{ range: Range; text: string }> = []
  let source: unknown
  const model = { uri, isDisposed: () => false, getValue: () => text, validateRange: (range: Range) => range,
    getValueInRange: (range: Range) => text.slice(range.startColumn - 1, range.endColumn - 1),
    pushStackElement: () => calls.push('boundary'), pushEditOperations: (_cursor: unknown, edits: typeof operations, _compute: unknown, _group: unknown, reason: unknown) => { calls.push('apply'); operations = edits; source = reason } }
  const exports = {}; const module = { exports }
  runInNewContext(code, { module, exports, require: (name: string) => name === 'monaco-editor' ? { Range,
    editor: { EditorOption: { readOnly: 1 }, getModels: () => [model], getEditors: () => [{ getModel: () => model, getOption: () => readOnly }] } }
    : name.endsWith('/textModelEditSource') ? { EditSources: { inlineCompletionAccept: (value: unknown) => value } } : '' })
  const apply = (module.exports as { applySuggestion: (snapshot: EditorSnapshot, candidate: Suggestion) => boolean }).applySuggestion
  const document = { uri, version: 1, getText: () => text }
  const fileId = `f-${contentHash(uri.toString())}`
  const snapshot = { document, version: 1, text, dependencies: [{ uri, text }], request: { active: { fileId, snapshotId: 'one' }, documents: [{ fileId, snapshotId: 'one', permission: 'edit' }], options: { crossFile: false } } } as unknown as EditorSnapshot
  const candidate: Suggestion = { candidateId: 'local', fileId, snapshotId: 'one', kind: 'edit', primary: {
    range: { start: { line: 0, character: 4 }, end: { line: 0, character: 11 } }, expectedText: 'oldName', newText: 'newName' },
    additionalEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, expectedText: '', newText: '#include <Arduino.h>\n' }] }
  return { apply, snapshot, candidate, document, calls, operations: () => operations, source: () => source,
    setText: (value: string) => { text = value }, setReadonly: () => { readOnly = true } }
}
test('primary edit and import use a single model transaction between undo boundaries', () => {
  const h = setup(); assert.equal(h.apply(h.snapshot, h.candidate), true)
  assert.deepEqual(h.calls, ['boundary', 'apply', 'boundary']); assert.equal(h.operations().length, 2)
  assert.equal((h.source() as { correlationId: string }).correlationId, h.candidate.candidateId)
})
test('source text/expected text/identity/read-only changes never partially apply an import', () => {
  for (const mutation of ['text', 'expected', 'identity', 'readonly']) {
    const h = setup()
    if (mutation === 'text') h.setText('int unrelated = 0;\n')
    if (mutation === 'expected') h.candidate.primary.expectedText = 'other'
    if (mutation === 'identity') h.candidate.snapshotId = 'other'
    if (mutation === 'readonly') h.setReadonly()
    assert.equal(h.apply(h.snapshot, h.candidate), false, mutation); assert.deepEqual(h.calls, [])
  }
})
test('identical-content document version drift can still apply atomically', () => {
  const h = setup(); h.document.version++
  assert.equal(h.apply(h.snapshot, h.candidate), true)
  assert.deepEqual(h.calls, ['boundary', 'apply', 'boundary'])
})
test('overlapping local actions are rejected before creating an undo group', () => {
  const h = setup(); h.candidate.additionalEdits[0]!.range = h.candidate.primary.range
  assert.equal(h.apply(h.snapshot, h.candidate), false); assert.deepEqual(h.calls, [])
})
test('cross-file transaction requires explicit permission even after target navigation', () => {
  const h = setup(); h.snapshot.request.active.fileId = 'source-header'; h.snapshot.request.mode = 'next-edit'
  assert.equal(h.apply(h.snapshot, h.candidate), false)
  h.snapshot.request.options.crossFile = true
  assert.equal(h.apply(h.snapshot, h.candidate), true)
  h.snapshot.request.documents[0]!.permission = 'context-only'
  assert.equal(h.apply(h.snapshot, h.candidate), false)
})
