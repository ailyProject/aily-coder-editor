import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NativeFsWatchEchoSuppressor,
  resolveNativeFsWatchTargetPath
} from './nativeFsWatchEvent.js'

test('keeps nested recursive watcher paths relative to the workspace root', () => {
  assert.equal(
    resolveNativeFsWatchTargetPath('/workspace/demo', {
      eventType: 'change',
      filename: '.log/app/latest.log'
    }),
    '/workspace/demo/.log/app/latest.log'
  )
})

test('normalizes the macOS synthetic workspace-name event back to the root', () => {
  assert.equal(
    resolveNativeFsWatchTargetPath('/workspace/demo', {
      eventType: 'change',
      filename: 'demo'
    }),
    '/workspace/demo'
  )
})

test('preserves a possible same-named child on rename events', () => {
  assert.equal(
    resolveNativeFsWatchTargetPath('/workspace/demo', {
      eventType: 'rename',
      filename: 'demo'
    }),
    '/workspace/demo/demo'
  )
})

test('maps missing filenames to the watch root and ignores watcher errors', () => {
  assert.equal(
    resolveNativeFsWatchTargetPath('/workspace/demo/', { eventType: 'change' }),
    '/workspace/demo'
  )
  assert.equal(
    resolveNativeFsWatchTargetPath('/workspace/demo', { eventType: 'error' }),
    undefined
  )
})

test('suppresses native echoes of local writes without hiding later changes', () => {
  let now = 1000
  const suppressor = new NativeFsWatchEchoSuppressor(500, () => now)

  suppressor.mark('/workspace/demo/sketch/src/main.cpp')
  assert.equal(suppressor.shouldSuppress('/workspace/demo/sketch/src/main.cpp'), true)
  now += 499
  assert.equal(suppressor.shouldSuppress('/workspace/demo/sketch/src/main.cpp'), true)
  now += 1
  assert.equal(suppressor.shouldSuppress('/workspace/demo/sketch/src/main.cpp'), false)
})

test('forgets suppression when a local write fails', () => {
  const suppressor = new NativeFsWatchEchoSuppressor()
  suppressor.mark('/workspace/demo/package.json')
  suppressor.forget('/workspace/demo/package.json')
  assert.equal(suppressor.shouldSuppress('/workspace/demo/package.json'), false)
})
