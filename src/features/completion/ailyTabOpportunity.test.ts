import assert from 'node:assert/strict'
import test from 'node:test'
import { editOrigin, hasRecentReplacement, isTypedLineBreak, minimalEdit, MAX_PREDICTION_CHAIN, selectionOpportunity } from './ailyTabOpportunity'

test('mouse caret moves and deliberate selections create next-edit opportunities', () => {
  assert.equal(selectionOpportunity('mouse', true), 'cursor')
  assert.equal(selectionOpportunity('mouse', false), 'selection')
  assert.equal(selectionOpportunity('keyboard', false), 'selection')
  assert.equal(selectionOpportunity('keyboard', true), undefined)
  assert.equal(selectionOpportunity('other', false), undefined)
})
test('native deletion command provenance preserves a delete-then-type word change', () => {
  for (const detailedSource of ['deleteLeft', 'deleteRight', 'deleteWordLeft', 'deleteWordRight', 'deleteWordStartLeft', 'deleteWordEndRight']) {
    assert.equal(editOrigin({ source: 'cursor', metadata: { kind: 'executeCommands', detailedSource } }), 'typing')
    assert.equal(editOrigin({ source: 'applyEdits', metadata: { kind: 'executeCommands', detailedSource } }), 'external')
  }
  assert.equal(editOrigin({ source: 'cursor', metadata: { kind: 'executeCommands', detailedSource: 'extension.edit' } }), 'external')
})
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
test('a repeated identifier rename remains one compact atomic edit', () => {
  const edit = minimalEdit({
    range: { start: { line: 20, character: 0 }, end: { line: 23, character: 0 } },
    expectedText: 'const bin = path.join(childPath, "node");\r\nlet custom = childPath;\r\nreturn custom;\r\n',
    newText: 'const bin = path.join(bac, "node");\r\nlet custom = bac;\r\nreturn custom;\r\n',
  })
  assert.deepEqual(edit, {
    range: { start: { line: 20, character: 22 }, end: { line: 21, character: 22 } },
    expectedText: 'childPath, "node");\r\nlet custom = childPath',
    newText: 'bac, "node");\r\nlet custom = bac',
  })
})
test('a local rename keeps every certain reference and its label in one transaction', () => {
  const edit = minimalEdit({ range: { start: { line: 4, character: 0 }, end: { line: 8, character: 0 } },
    expectedText: '  if (distTb > 3000) return 0;\n  if (distTb > 2000) return 1;\n  console.log("distTb", distTb);\n  return 3;\n',
    newText: '  if (AC > 3000) return 0;\n  if (AC > 2000) return 1;\n  console.log("AC", AC);\n  return 3;\n' })
  assert.equal(edit.range.start.line, 4)
  assert.equal(edit.range.end.line, 6)
  assert.equal((edit.expectedText.match(/distTb/g) ?? []).length, 4)
  assert.equal((edit.newText.match(/AC/g) ?? []).length, 4)
})
