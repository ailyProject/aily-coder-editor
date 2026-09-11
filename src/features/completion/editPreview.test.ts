import assert from 'node:assert/strict'
import test from 'node:test'
import { describeEditPreview } from './editPreview'

test('single token correction previews the complete resulting source line', () => {
  const value = describeEditPreview('void f() {\n    Serial.prinln("ok");\n}', {
    range: { start: { line: 1, character: 15 }, end: { line: 1, character: 15 } }, expectedText: '', newText: 't'
  })
  assert.equal(value.after, '    Serial.println("ok");')
  assert.equal(value.singleLine, true)
  assert.equal(value.lastLine, 1)
  assert.deepEqual(value.afterHighlights, [{ line: 0, start: 15, end: 16 }])
})
test('multiline preview preserves indentation without including the following untouched line', () => {
  const value = describeEditPreview('void f() {\r\n    old();\r\n    done();\r\n}', {
    range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, expectedText: '    old();\r\n', newText: '    first();\r\n    second();\r\n'
  })
  assert.equal(value.before, '    old();')
  assert.equal(value.after, '    first();\n    second();')
  assert.equal(value.lastLine, 1)
  assert.equal(value.singleLine, false)
  assert.deepEqual(value.beforeHighlights, [{ line: 0, start: 4, end: 7 }])
  assert.deepEqual(value.afterHighlights, [{ line: 0, start: 4, end: 9 }, { line: 1, start: 4, end: 13 }])
})
test('replacement and deletion preview keep unchanged UTF-16 prefixes and suffixes', () => {
  const edit = { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, expectedText: 'old', newText: 'new' }
  assert.equal(describeEditPreview('😀old();', edit).after, '😀new();')
  assert.equal(describeEditPreview('😀old();', { ...edit, newText: '' }).after, '😀();')
})
test('rename preview highlights each changed reference and label independently', () => {
  const value = describeEditPreview('  if (distTb > 2000) return 1;\n  console.log("distTb", distTb);\n', {
    range: { start: { line: 0, character: 6 }, end: { line: 1, character: 30 } },
    expectedText: 'distTb > 2000) return 1;\n  console.log("distTb", distTb',
    newText: 'AC > 2000) return 1;\n  console.log("AC", AC',
  })
  assert.deepEqual(value.beforeHighlights, [
    { line: 0, start: 6, end: 12 },
    { line: 1, start: 15, end: 21 },
    { line: 1, start: 24, end: 30 },
  ])
  assert.deepEqual(value.afterHighlights, [
    { line: 0, start: 6, end: 8 },
    { line: 1, start: 15, end: 17 },
    { line: 1, start: 20, end: 22 },
  ])
})
