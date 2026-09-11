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
})
test('multiline preview preserves indentation without including the following untouched line', () => {
  const value = describeEditPreview('void f() {\r\n    old();\r\n    done();\r\n}', {
    range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, expectedText: '    old();\r\n', newText: '    first();\r\n    second();\r\n'
  })
  assert.deepEqual(value, { before: '    old();', after: '    first();\n    second();', lastLine: 1, singleLine: false })
})
test('replacement and deletion preview keep unchanged UTF-16 prefixes and suffixes', () => {
  const edit = { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, expectedText: 'old', newText: 'new' }
  assert.equal(describeEditPreview('😀old();', edit).after, '😀new();')
  assert.equal(describeEditPreview('😀old();', { ...edit, newText: '' }).after, '😀();')
})
