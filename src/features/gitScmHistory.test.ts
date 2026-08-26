import assert from 'node:assert/strict'
import test from 'node:test'
import {
  historyRefsByRevision,
  parseGitHistoryItemChanges,
  parseGitHistoryItems
} from './gitScmHistory.js'

test('parses multiline commit messages and topology from NUL fields', () => {
  const first = 'a'.repeat(40)
  const parent = 'b'.repeat(40)
  const second = 'c'.repeat(40)
  const raw = [
    first, parent, 'Alice', 'alice@example.com', '1720000000', 'subject', 'subject\n\nbody line',
    `\n${second}`, '', 'Bob', 'bob@example.com', '1720000100', 'root', 'root',
    ''
  ].join('\0')

  const items = parseGitHistoryItems(raw)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0]?.parentIds, [parent])
  assert.equal(items[0]?.message, 'subject\n\nbody line')
  assert.equal(items[1]?.timestamp, 1720000100000)
})

test('parses modified, added, renamed and copied file records', () => {
  assert.deepEqual(
    parseGitHistoryItemChanges([
      'M', 'sketch/src/main.cpp',
      'A', 'package.json',
      'R100', 'sketch/src/old.cpp', 'sketch/src/new.cpp',
      'C090', 'sketch/src/source.cpp', 'sketch/src/copy.cpp',
      ''
    ].join('\0')),
    [
      { status: 'M', path: 'sketch/src/main.cpp' },
      { status: 'A', path: 'package.json' },
      { status: 'R100', originalPath: 'sketch/src/old.cpp', path: 'sketch/src/new.cpp' },
      { status: 'C090', originalPath: 'sketch/src/source.cpp', path: 'sketch/src/copy.cpp' }
    ]
  )
})

test('groups branch and tag badges by commit revision', () => {
  const revision = 'd'.repeat(40)
  const refs = historyRefsByRevision([
    { id: 'refs/heads/main', name: 'main', revision, category: 'local' },
    { id: 'refs/tags/v1', name: 'v1', revision, category: 'tag' }
  ])
  assert.deepEqual(refs.get(revision)?.map((ref) => ref.name), ['main', 'v1'])
})
