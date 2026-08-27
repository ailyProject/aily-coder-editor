import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseGitPorcelainZ,
  shouldRefreshGitScmForPath
} from './gitScmStatus.js'

test('keeps paths from the current sketch layout', () => {
  const entries = parseGitPorcelainZ([
    ' M sketch/src/main.cpp',
    '?? sketch/libraries/Servo/Servo.cpp',
    ' M package.json',
    ''
  ].join('\0'))

  assert.deepEqual(entries.map((entry) => entry.path), [
    'sketch/src/main.cpp',
    'sketch/libraries/Servo/Servo.cpp',
    'package.json'
  ])
})

test('filters generated and dependency directories at any depth', () => {
  const entries = parseGitPorcelainZ([
    '?? .build/release/firmware.bin',
    '?? node_modules/pkg/index.js',
    ' M nested/.BUILD/cache.txt',
    ' M sketch/node_modules/pkg/index.js',
    ' M .aily/build/output.hex',
    ' M .log/build.log',
    ' M .workspace-history/state.json',
    ' M sketch/src/keep.cpp',
    ''
  ].join('\0'))

  assert.deepEqual(entries.map((entry) => entry.path), ['sketch/src/keep.cpp'])
})

test('ignores generated directory events that could feed Git command logs back into SCM', () => {
  for (const path of [
    '.log/app/20260826/18-02.log',
    'nested/.LOG/app.log',
    '.aily/build/main.hex',
    '.build/sketch/main.cpp.o',
    '.workspace-history/state.json',
    'node_modules/pkg/index.js'
  ]) {
    assert.equal(shouldRefreshGitScmForPath(path, true), false, path)
  }
  assert.equal(shouldRefreshGitScmForPath('sketch/src/main.cpp', true), true)
})

test('only rechecks an uninitialized repository when Git metadata appears', () => {
  assert.equal(shouldRefreshGitScmForPath('sketch/src/main.cpp', false), false)
  assert.equal(shouldRefreshGitScmForPath('.git', false), true)
  assert.equal(shouldRefreshGitScmForPath('.git/HEAD', false), true)
  assert.equal(shouldRefreshGitScmForPath('', false), false)
})
