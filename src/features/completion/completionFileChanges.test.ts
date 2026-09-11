import assert from 'node:assert/strict'
import test from 'node:test'
import { affectsCompletionContext } from './completionFileChanges'

test('host log writes and generated files do not cancel a pending suggestion', () => {
  for (const path of ['.log/app/20260910/22-05.log', '.log/app/package.json', 'logs/error.cpp', '.aily/history.json', 'build/generated.cpp', '.cache/compile_commands.json', 'README.md']) {
    assert.equal(affectsCompletionContext(`/project/${path}`, '/project', ['/project/sketch/src/main.cpp']), false, path)
  }
})
test('source and toolchain changes still invalidate completion context', () => {
  for (const path of ['sketch/src/main.cpp', 'sketch/src/Sensor.h', 'package.json', 'compile_commands.json', 'compile_flags.txt', 'coder-embed-hints.json']) {
    assert.equal(affectsCompletionContext(`/project/${path}`, '/project', []), true, path)
  }
})
test('captured library and SDK dependencies remain protected without cross-project invalidation', () => {
  assert.equal(affectsCompletionContext('/project/node_modules/lib/Device.h', '/project', ['/project/node_modules/lib/Device.h']), true)
  assert.equal(affectsCompletionContext('/installed/SDK/Arduino.h', '/project', ['/installed/SDK/Arduino.h']), true)
  assert.equal(affectsCompletionContext('/project-other/main.cpp', '/project', []), false)
  assert.equal(affectsCompletionContext('C:\\project\\.log\\app.log', 'C:\\project', []), false)
  assert.equal(affectsCompletionContext('C:\\project\\main.cpp', 'C:\\project', []), true)
})
