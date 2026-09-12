import assert from 'node:assert/strict'
import test from 'node:test'
import { ClipboardHistoryStore } from './clipboardHistory'

test('copy and cut history is recent-first, deduplicated and workspace scoped', () => {
  const history = new ClipboardHistoryStore()
  history.add('workspace-a', 'source.cpp', 'cpp', 'int copied = 1;', 'copy', 1000)
  history.add('workspace-a', 'source.cpp', 'cpp', 'int copied = 1;', 'cut', 1001)
  history.add('workspace-b', 'other.cpp', 'cpp', 'int unrelated = 2;', 'copy', 1002)
  assert.deepEqual(history.read('workspace-a', 1100), [{ operation: 'cut', text: 'int copied = 1;', relativePath: 'source.cpp', languageId: 'cpp', ageMs: 99 }])
  assert.equal(history.read('workspace-b', 1100).length, 1)
  assert.equal(history.read('workspace-a', 301002).length, 0)
  history.clear()
  assert.equal(history.read('workspace-b', 1100).length, 0)
})

test('clipboard excerpts respect count, total size and Unicode boundaries', () => {
  const history = new ClipboardHistoryStore()
  for (let index = 0; index < 8; index++) history.add('workspace', `source${index}.cpp`, 'cpp', `int value${index};`, 'copy', index)
  assert.equal(history.read('workspace', 10).length, 5)
  history.clear()
  history.add('workspace', 'first.cpp', 'cpp', 'a'.repeat(2047) + '😀\n', 'copy', 1)
  assert.equal(history.read('workspace', 2)[0]!.text, 'a'.repeat(2047))
  history.add('workspace', 'second.cpp', 'cpp', 'b'.repeat(2047) + '\r\n', 'copy', 2)
  assert.equal(history.read('workspace', 3)[0]!.text, 'b'.repeat(2047))
  history.add('workspace', 'third.cpp', 'cpp', 'c'.repeat(2048), 'copy', 3)
  assert.equal(history.read('workspace', 4).length, 2)
  assert.ok(history.read('workspace', 4).reduce((sum, item) => sum + item.text.length, 0) <= 4096)
})

test('clipboard capture excludes outside paths, dependencies, generated files and empty data', () => {
  const history = new ClipboardHistoryStore()
  for (const path of ['/private.cpp', '../other.cpp', 'C:\\private.cpp', 'src/../../other.cpp', 'node_modules/lib.cpp', 'build/generated.cpp', '.env', 'notes.txt']) {
    assert.equal(history.add('workspace', path, 'cpp', 'private data', 'copy'), false, path)
  }
  assert.equal(history.add('workspace', 'main.cpp', 'cpp', ' \n\t', 'copy'), false)
  assert.equal(history.add('workspace', 'main.cpp', 'cpp', 'a\0b', 'copy'), false)
  assert.equal(history.add('workspace', 'src\\main.cpp', 'cpp', 'code', 'copy'), true)
  assert.equal(history.read('workspace')[0]!.relativePath, 'src/main.cpp')
})
