import assert from 'node:assert/strict'
import test from 'node:test'
import { editOrigin, focusFirstRenameReference, hasRecentReplacement, isTypedLineBreak, minimalEdit, MAX_PREDICTION_CHAIN } from './ailyTabOpportunity'
test('physical Enter stays a continuation opportunity after a recent rename', () => {
  const rename = [{ fileId: 'main', origin: 'typing' as const, before: 'old', after: 'new', ageMs: 20 }]
  assert.equal(hasRecentReplacement(rename, 'main'), true)
  for (const text of ['\n', '\n    ', '\r\n\t', '\n    \n', '\r\n\t\r\n']) {
    assert.equal(isTypedLineBreak([{ text, rangeLength: 0 }], 'typing'), true, JSON.stringify(text))
    for (const origin of ['paste', 'external', 'completion', 'undo', 'redo'] as const)
      assert.equal(isTypedLineBreak([{ text, rangeLength: 0 }], origin), false)
  }
  for (const text of ['', 'foo\nbar', '\n\n\n', '    ']) assert.equal(isTypedLineBreak([{ text, rangeLength: 0 }], 'typing'), false)
  assert.equal(isTypedLineBreak([{ text: '\n', rangeLength: 0 }, { text: '\n', rangeLength: 0 }], 'typing'), false)
})
test('real Workbench provenance separates typing, paste, native acceptance and external writes', () => {
  for (const kind of ['type', 'compositionType', 'compositionEnd']) assert.equal(editOrigin({ source: 'cursor', metadata: { kind } }), 'typing')
  assert.equal(editOrigin({ source: 'cursor', metadata: { kind: 'paste' } }), 'paste')
  for (const source of ['inlineCompletionAccept', 'inlineCompletionPartialAccept']) assert.equal(editOrigin({ source }), 'completion')
  for (const source of ['reloadFromDisk', 'Chat.applyEdits', 'applyEdits', 'setValue', 'unknown']) assert.equal(editOrigin({ source }), 'external')
  assert.equal(editOrigin(undefined), 'external')
  assert.equal(hasRecentReplacement([{ fileId: 'main', origin: 'external', before: 'old', after: 'new', ageMs: 0 }], 'main'), false)
})
test('ordinary typing does not also schedule next-edit, but a recent replacement does', () => {
  const edit = { fileId: 'main', origin: 'typing' as const, before: '', after: 'fir', ageMs: 50 }
  assert.equal(hasRecentReplacement([edit], 'main'), false)
  assert.equal(hasRecentReplacement([{ ...edit, before: 'old' }], 'main'), true)
  for (const variant of [{ before: 'old', after: '' }, { before: 'old', origin: 'undo' as const }, { before: 'old', ageMs: 2001 }]) assert.equal(hasRecentReplacement([{ ...edit, ...variant }], 'main'), false)
  assert.equal(MAX_PREDICTION_CHAIN, 5)
})
test('edit previews show only changed text while preserving exact UTF-16 positions', () => {
  assert.deepEqual(minimalEdit({ range: { start: { line: 4, character: 0 }, end: { line: 7, character: 0 } }, expectedText: 'int sum() {\r\n  return a;\r\n}\r\n', newText: 'int sum() {\r\n  return a + b;\r\n}\r\n' }),
    { range: { start: { line: 5, character: 10 }, end: { line: 5, character: 10 } }, expectedText: '', newText: ' + b' })
  const edit = minimalEdit({ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } }, expectedText: '😀abc', newText: '😃abc' })
  assert.equal(edit.expectedText, '😀'); assert.equal(edit.newText, '😃'); assert.equal(edit.range.start.character, 3); assert.equal(edit.range.end.character, 5)
})
test('a repeated identifier rename is presented one reference line at a time', () => {
  const edit = focusFirstRenameReference({
    range: { start: { line: 20, character: 0 }, end: { line: 23, character: 0 } },
    expectedText: 'const bin = path.join(childPath, "node");\r\nlet custom = childPath;\r\nreturn custom;\r\n',
    newText: 'const bin = path.join(bac, "node");\r\nlet custom = bac;\r\nreturn custom;\r\n',
  }, [{ fileId: 'main', before: 'childPath', after: 'bac', ageMs: 20, origin: 'typing' }])
  assert.deepEqual(minimalEdit(edit), {
    range: { start: { line: 20, character: 22 }, end: { line: 20, character: 31 } },
    expectedText: 'childPath', newText: 'bac',
  })
})
test('a genuine multi-line rewrite stays together', () => {
  const edit = { range: { start: { line: 3, character: 0 }, end: { line: 5, character: 0 } },
    expectedText: 'int left = first;\nint right = second;\n', newText: 'int left = values[0];\nint right = values[1];\n' }
  assert.equal(focusFirstRenameReference(edit, [{ fileId: 'main', before: 'first', after: 'values', ageMs: 10, origin: 'typing' }]), edit)
})
test('an accepted rename chain can keep splitting references after model latency', () => {
  const edit = { range: { start: { line: 8, character: 0 }, end: { line: 10, character: 0 } },
    expectedText: 'use(oldName);\nlog(oldName);\n', newText: 'use(newName);\nlog(newName);\n' }
  const history = [{ fileId: 'main', before: 'oldName', after: 'newName', ageMs: 12_000, origin: 'typing' as const }]
  assert.equal(focusFirstRenameReference(edit, history), edit)
  assert.deepEqual(minimalEdit(focusFirstRenameReference(edit, history, 60_000)), {
    range: { start: { line: 8, character: 4 }, end: { line: 8, character: 7 } }, expectedText: 'old', newText: 'new',
  })
})
test('a one-line rename never consumes a provider-omitted terminal newline', () => {
  const edit = focusFirstRenameReference({ range: { start: { line: 4, character: 0 }, end: { line: 5, character: 0 } },
    expectedText: '    use(sensorPort);\n', newText: '    use(sensorPin);' },
  [{ fileId: 'main', before: 'sensorPort', after: 'sensorPin', ageMs: 20, origin: 'typing' }])
  assert.deepEqual(minimalEdit(edit), { range: { start: { line: 4, character: 15 }, end: { line: 4, character: 18 } },
    expectedText: 'ort', newText: 'in' })
})
