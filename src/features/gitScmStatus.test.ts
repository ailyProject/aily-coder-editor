import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGitPorcelainZ } from './gitScmStatus.js'

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
